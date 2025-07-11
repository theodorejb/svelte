/** @import { Derived, Effect, Reaction, Signal, Source, Value } from '#client' */
import { DEV } from 'esm-env';
import { define_property, get_descriptors, get_prototype_of, index_of } from '../shared/utils.js';
import {
	destroy_block_effect_children,
	destroy_effect_children,
	execute_effect_teardown,
	unlink_effect
} from './reactivity/effects.js';
import {
	EFFECT,
	DIRTY,
	MAYBE_DIRTY,
	CLEAN,
	DERIVED,
	UNOWNED,
	DESTROYED,
	INERT,
	BRANCH_EFFECT,
	STATE_SYMBOL,
	BLOCK_EFFECT,
	ROOT_EFFECT,
	DISCONNECTED,
	EFFECT_IS_UPDATING,
	STALE_REACTION,
	USER_EFFECT
} from './constants.js';
import { flush_tasks } from './dom/task.js';
import { internal_set, old_values } from './reactivity/sources.js';
import { destroy_derived_effects, execute_derived, update_derived } from './reactivity/deriveds.js';
import * as e from './errors.js';

import { tracing_mode_flag } from '../flags/index.js';
import { tracing_expressions, get_stack } from './dev/tracing.js';
import {
	component_context,
	dev_current_component_function,
	dev_stack,
	is_runes,
	set_component_context,
	set_dev_current_component_function,
	set_dev_stack
} from './context.js';
import { handle_error, invoke_error_boundary } from './error-handling.js';
import { UNINITIALIZED } from '../../constants.js';

let is_flushing = false;

/** @type {Effect | null} */
let last_scheduled_effect = null;

let is_updating_effect = false;

export let is_destroying_effect = false;

/** @param {boolean} value */
export function set_is_destroying_effect(value) {
	is_destroying_effect = value;
}

// Handle effect queues

/** @type {Effect[]} */
let queued_root_effects = [];

/** @type {Effect[]} Stack of effects, dev only */
let dev_effect_stack = [];
// Handle signal reactivity tree dependencies and reactions

/** @type {null | Reaction} */
export let active_reaction = null;

export let untracking = false;

/** @param {null | Reaction} reaction */
export function set_active_reaction(reaction) {
	active_reaction = reaction;
}

/** @type {null | Effect} */
export let active_effect = null;

/** @param {null | Effect} effect */
export function set_active_effect(effect) {
	active_effect = effect;
}

/**
 * When sources are created within a reaction, reading and writing
 * them within that reaction should not cause a re-run
 * @type {null | { reaction: Reaction, sources: Source[] }}
 */
export let source_ownership = null;

/** @param {Value} value */
export function push_reaction_value(value) {
	if (active_reaction !== null && active_reaction.f & EFFECT_IS_UPDATING) {
		if (source_ownership === null) {
			source_ownership = { reaction: active_reaction, sources: [value] };
		} else {
			source_ownership.sources.push(value);
		}
	}
}

/**
 * The dependencies of the reaction that is currently being executed. In many cases,
 * the dependencies are unchanged between runs, and so this will be `null` unless
 * and until a new dependency is accessed — we track this via `skipped_deps`
 * @type {null | Value[]}
 */
let new_deps = null;

let skipped_deps = 0;

/**
 * Tracks writes that the effect it's executed in doesn't listen to yet,
 * so that the dependency can be added to the effect later on if it then reads it
 * @type {null | Source[]}
 */
export let untracked_writes = null;

/** @param {null | Source[]} value */
export function set_untracked_writes(value) {
	untracked_writes = value;
}

/**
 * @type {number} Used by sources and deriveds for handling updates.
 * Version starts from 1 so that unowned deriveds differentiate between a created effect and a run one for tracing
 **/
let write_version = 1;

/** @type {number} Used to version each read of a source of derived to avoid duplicating depedencies inside a reaction */
let read_version = 0;

// If we are working with a get() chain that has no active container,
// to prevent memory leaks, we skip adding the reaction.
export let skip_reaction = false;
// Handle collecting all signals which are read during a specific time frame
/** @type {Set<Value> | null} */
export let captured_signals = null;

/** @param {Set<Value> | null} value */
export function set_captured_signals(value) {
	captured_signals = value;
}

export function increment_write_version() {
	return ++write_version;
}

/**
 * Determines whether a derived or effect is dirty.
 * If it is MAYBE_DIRTY, will set the status to CLEAN
 * @param {Reaction} reaction
 * @returns {boolean}
 */
export function check_dirtiness(reaction) {
	var flags = reaction.f;

	if ((flags & DIRTY) !== 0) {
		return true;
	}

	if ((flags & MAYBE_DIRTY) !== 0) {
		var dependencies = reaction.deps;
		var is_unowned = (flags & UNOWNED) !== 0;

		if (dependencies !== null) {
			var i;
			var dependency;
			var is_disconnected = (flags & DISCONNECTED) !== 0;
			var is_unowned_connected = is_unowned && active_effect !== null && !skip_reaction;
			var length = dependencies.length;

			// If we are working with a disconnected or an unowned signal that is now connected (due to an active effect)
			// then we need to re-connect the reaction to the dependency
			if (is_disconnected || is_unowned_connected) {
				var derived = /** @type {Derived} */ (reaction);
				var parent = derived.parent;

				for (i = 0; i < length; i++) {
					dependency = dependencies[i];

					// We always re-add all reactions (even duplicates) if the derived was
					// previously disconnected, however we don't if it was unowned as we
					// de-duplicate dependencies in that case
					if (is_disconnected || !dependency?.reactions?.includes(derived)) {
						(dependency.reactions ??= []).push(derived);
					}
				}

				if (is_disconnected) {
					derived.f ^= DISCONNECTED;
				}
				// If the unowned derived is now fully connected to the graph again (it's unowned and reconnected, has a parent
				// and the parent is not unowned), then we can mark it as connected again, removing the need for the unowned
				// flag
				if (is_unowned_connected && parent !== null && (parent.f & UNOWNED) === 0) {
					derived.f ^= UNOWNED;
				}
			}

			for (i = 0; i < length; i++) {
				dependency = dependencies[i];

				if (check_dirtiness(/** @type {Derived} */ (dependency))) {
					update_derived(/** @type {Derived} */ (dependency));
				}

				if (dependency.wv > reaction.wv) {
					return true;
				}
			}
		}

		// Unowned signals should never be marked as clean unless they
		// are used within an active_effect without skip_reaction
		if (!is_unowned || (active_effect !== null && !skip_reaction)) {
			set_signal_status(reaction, CLEAN);
		}
	}

	return false;
}

/**
 * @param {Value} signal
 * @param {Effect} effect
 * @param {boolean} [root]
 */
function schedule_possible_effect_self_invalidation(signal, effect, root = true) {
	var reactions = signal.reactions;
	if (reactions === null) return;

	for (var i = 0; i < reactions.length; i++) {
		var reaction = reactions[i];

		if (
			source_ownership?.reaction === active_reaction &&
			source_ownership.sources.includes(signal)
		) {
			continue;
		}

		if ((reaction.f & DERIVED) !== 0) {
			schedule_possible_effect_self_invalidation(/** @type {Derived} */ (reaction), effect, false);
		} else if (effect === reaction) {
			if (root) {
				set_signal_status(reaction, DIRTY);
			} else if ((reaction.f & CLEAN) !== 0) {
				set_signal_status(reaction, MAYBE_DIRTY);
			}
			schedule_effect(/** @type {Effect} */ (reaction));
		}
	}
}

/** @param {Reaction} reaction */
export function update_reaction(reaction) {
	var previous_deps = new_deps;
	var previous_skipped_deps = skipped_deps;
	var previous_untracked_writes = untracked_writes;
	var previous_reaction = active_reaction;
	var previous_skip_reaction = skip_reaction;
	var previous_reaction_sources = source_ownership;
	var previous_component_context = component_context;
	var previous_untracking = untracking;

	var flags = reaction.f;

	new_deps = /** @type {null | Value[]} */ (null);
	skipped_deps = 0;
	untracked_writes = null;
	skip_reaction =
		(flags & UNOWNED) !== 0 && (untracking || !is_updating_effect || active_reaction === null);
	active_reaction = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) === 0 ? reaction : null;

	source_ownership = null;
	set_component_context(reaction.ctx);
	untracking = false;
	read_version++;

	reaction.f |= EFFECT_IS_UPDATING;

	if (reaction.ac !== null) {
		reaction.ac.abort(STALE_REACTION);
		reaction.ac = null;
	}

	try {
		var result = /** @type {Function} */ (0, reaction.fn)();
		var deps = reaction.deps;

		if (new_deps !== null) {
			var i;

			remove_reactions(reaction, skipped_deps);

			if (deps !== null && skipped_deps > 0) {
				deps.length = skipped_deps + new_deps.length;
				for (i = 0; i < new_deps.length; i++) {
					deps[skipped_deps + i] = new_deps[i];
				}
			} else {
				reaction.deps = deps = new_deps;
			}

			if (
				!skip_reaction ||
				// Deriveds that already have reactions can cleanup, so we still add them as reactions
				((flags & DERIVED) !== 0 &&
					/** @type {import('#client').Derived} */ (reaction).reactions !== null)
			) {
				for (i = skipped_deps; i < deps.length; i++) {
					(deps[i].reactions ??= []).push(reaction);
				}
			}
		} else if (deps !== null && skipped_deps < deps.length) {
			remove_reactions(reaction, skipped_deps);
			deps.length = skipped_deps;
		}

		// If we're inside an effect and we have untracked writes, then we need to
		// ensure that if any of those untracked writes result in re-invalidation
		// of the current effect, then that happens accordingly
		if (
			is_runes() &&
			untracked_writes !== null &&
			!untracking &&
			deps !== null &&
			(reaction.f & (DERIVED | MAYBE_DIRTY | DIRTY)) === 0
		) {
			for (i = 0; i < /** @type {Source[]} */ (untracked_writes).length; i++) {
				schedule_possible_effect_self_invalidation(
					untracked_writes[i],
					/** @type {Effect} */ (reaction)
				);
			}
		}

		// If we are returning to an previous reaction then
		// we need to increment the read version to ensure that
		// any dependencies in this reaction aren't marked with
		// the same version
		if (previous_reaction !== null && previous_reaction !== reaction) {
			read_version++;

			if (untracked_writes !== null) {
				if (previous_untracked_writes === null) {
					previous_untracked_writes = untracked_writes;
				} else {
					previous_untracked_writes.push(.../** @type {Source[]} */ (untracked_writes));
				}
			}
		}

		return result;
	} catch (error) {
		handle_error(error);
	} finally {
		new_deps = previous_deps;
		skipped_deps = previous_skipped_deps;
		untracked_writes = previous_untracked_writes;
		active_reaction = previous_reaction;
		skip_reaction = previous_skip_reaction;
		source_ownership = previous_reaction_sources;
		set_component_context(previous_component_context);
		untracking = previous_untracking;

		reaction.f ^= EFFECT_IS_UPDATING;
	}
}

/**
 * @template V
 * @param {Reaction} signal
 * @param {Value<V>} dependency
 * @returns {void}
 */
function remove_reaction(signal, dependency) {
	let reactions = dependency.reactions;
	if (reactions !== null) {
		var index = index_of.call(reactions, signal);
		if (index !== -1) {
			var new_length = reactions.length - 1;
			if (new_length === 0) {
				reactions = dependency.reactions = null;
			} else {
				// Swap with last element and then remove.
				reactions[index] = reactions[new_length];
				reactions.pop();
			}
		}
	}
	// If the derived has no reactions, then we can disconnect it from the graph,
	// allowing it to either reconnect in the future, or be GC'd by the VM.
	if (
		reactions === null &&
		(dependency.f & DERIVED) !== 0 &&
		// Destroying a child effect while updating a parent effect can cause a dependency to appear
		// to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
		// allows us to skip the expensive work of disconnecting and immediately reconnecting it
		(new_deps === null || !new_deps.includes(dependency))
	) {
		set_signal_status(dependency, MAYBE_DIRTY);
		// If we are working with a derived that is owned by an effect, then mark it as being
		// disconnected.
		if ((dependency.f & (UNOWNED | DISCONNECTED)) === 0) {
			dependency.f ^= DISCONNECTED;
		}
		// Disconnect any reactions owned by this reaction
		destroy_derived_effects(/** @type {Derived} **/ (dependency));
		remove_reactions(/** @type {Derived} **/ (dependency), 0);
	}
}

/**
 * @param {Reaction} signal
 * @param {number} start_index
 * @returns {void}
 */
export function remove_reactions(signal, start_index) {
	var dependencies = signal.deps;
	if (dependencies === null) return;

	for (var i = start_index; i < dependencies.length; i++) {
		remove_reaction(signal, dependencies[i]);
	}
}

/**
 * @param {Effect} effect
 * @returns {void}
 */
export function update_effect(effect) {
	var flags = effect.f;

	if ((flags & DESTROYED) !== 0) {
		return;
	}

	set_signal_status(effect, CLEAN);

	var previous_effect = active_effect;
	var was_updating_effect = is_updating_effect;

	active_effect = effect;
	is_updating_effect = true;

	if (DEV) {
		var previous_component_fn = dev_current_component_function;
		set_dev_current_component_function(effect.component_function);
		var previous_stack = /** @type {any} */ (dev_stack);
		// only block effects have a dev stack, keep the current one otherwise
		set_dev_stack(effect.dev_stack ?? dev_stack);
	}

	try {
		if ((flags & BLOCK_EFFECT) !== 0) {
			destroy_block_effect_children(effect);
		} else {
			destroy_effect_children(effect);
		}

		execute_effect_teardown(effect);
		var teardown = update_reaction(effect);
		effect.teardown = typeof teardown === 'function' ? teardown : null;
		effect.wv = write_version;

		// In DEV, increment versions of any sources that were written to during the effect,
		// so that they are correctly marked as dirty when the effect re-runs
		if (DEV && tracing_mode_flag && (effect.f & DIRTY) !== 0 && effect.deps !== null) {
			for (var dep of effect.deps) {
				if (dep.set_during_effect) {
					dep.wv = increment_write_version();
					dep.set_during_effect = false;
				}
			}
		}

		if (DEV) {
			dev_effect_stack.push(effect);
		}
	} finally {
		is_updating_effect = was_updating_effect;
		active_effect = previous_effect;

		if (DEV) {
			set_dev_current_component_function(previous_component_fn);
			set_dev_stack(previous_stack);
		}
	}
}

function log_effect_stack() {
	// eslint-disable-next-line no-console
	console.error(
		'Last ten effects were: ',
		dev_effect_stack.slice(-10).map((d) => d.fn)
	);
	dev_effect_stack = [];
}

function infinite_loop_guard() {
	try {
		e.effect_update_depth_exceeded();
	} catch (error) {
		if (DEV) {
			// stack is garbage, ignore. Instead add a console.error message.
			define_property(error, 'stack', {
				value: ''
			});
		}
		// Try and handle the error so it can be caught at a boundary, that's
		// if there's an effect available from when it was last scheduled
		if (last_scheduled_effect !== null) {
			if (DEV) {
				try {
					invoke_error_boundary(error, last_scheduled_effect);
				} catch (e) {
					// Only log the effect stack if the error is re-thrown
					log_effect_stack();
					throw e;
				}
			} else {
				invoke_error_boundary(error, last_scheduled_effect);
			}
		} else {
			if (DEV) {
				log_effect_stack();
			}
			throw error;
		}
	}
}

function flush_queued_root_effects() {
	var was_updating_effect = is_updating_effect;

	try {
		var flush_count = 0;
		is_updating_effect = true;

		while (queued_root_effects.length > 0) {
			if (flush_count++ > 1000) {
				infinite_loop_guard();
			}

			var root_effects = queued_root_effects;
			var length = root_effects.length;

			queued_root_effects = [];

			for (var i = 0; i < length; i++) {
				var collected_effects = process_effects(root_effects[i]);
				flush_queued_effects(collected_effects);
			}
			old_values.clear();
		}
	} finally {
		is_flushing = false;
		is_updating_effect = was_updating_effect;

		last_scheduled_effect = null;
		if (DEV) {
			dev_effect_stack = [];
		}
	}
}

/**
 * @param {Array<Effect>} effects
 * @returns {void}
 */
function flush_queued_effects(effects) {
	var length = effects.length;
	if (length === 0) return;

	for (var i = 0; i < length; i++) {
		var effect = effects[i];

		if ((effect.f & (DESTROYED | INERT)) === 0) {
			if (check_dirtiness(effect)) {
				var wv = write_version;

				update_effect(effect);

				// Effects with no dependencies or teardown do not get added to the effect tree.
				// Deferred effects (e.g. `$effect(...)`) _are_ added to the tree because we
				// don't know if we need to keep them until they are executed. Doing the check
				// here (rather than in `update_effect`) allows us to skip the work for
				// immediate effects.
				if (effect.deps === null && effect.first === null && effect.nodes_start === null) {
					if (effect.teardown === null) {
						// remove this effect from the graph
						unlink_effect(effect);
					} else {
						// keep the effect in the graph, but free up some memory
						effect.fn = null;
					}
				}

				// if state is written in a user effect, abort and re-schedule, lest we run
				// effects that should be removed as a result of the state change
				if (write_version > wv && (effect.f & USER_EFFECT) !== 0) {
					break;
				}
			}
		}
	}

	for (; i < length; i += 1) {
		schedule_effect(effects[i]);
	}
}

/**
 * @param {Effect} signal
 * @returns {void}
 */
export function schedule_effect(signal) {
	if (!is_flushing) {
		is_flushing = true;
		queueMicrotask(flush_queued_root_effects);
	}

	var effect = (last_scheduled_effect = signal);

	while (effect.parent !== null) {
		effect = effect.parent;
		var flags = effect.f;

		if ((flags & (ROOT_EFFECT | BRANCH_EFFECT)) !== 0) {
			if ((flags & CLEAN) === 0) return;
			effect.f ^= CLEAN;
		}
	}

	queued_root_effects.push(effect);
}

/**
 *
 * This function both runs render effects and collects user effects in topological order
 * from the starting effect passed in. Effects will be collected when they match the filtered
 * bitwise flag passed in only. The collected effects array will be populated with all the user
 * effects to be flushed.
 *
 * @param {Effect} root
 * @returns {Effect[]}
 */
function process_effects(root) {
	/** @type {Effect[]} */
	var effects = [];

	/** @type {Effect | null} */
	var effect = root;

	while (effect !== null) {
		var flags = effect.f;
		var is_branch = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) !== 0;
		var is_skippable_branch = is_branch && (flags & CLEAN) !== 0;

		if (!is_skippable_branch && (flags & INERT) === 0) {
			if ((flags & EFFECT) !== 0) {
				effects.push(effect);
			} else if (is_branch) {
				effect.f ^= CLEAN;
			} else {
				if (check_dirtiness(effect)) {
					update_effect(effect);
				}
			}

			/** @type {Effect | null} */
			var child = effect.first;

			if (child !== null) {
				effect = child;
				continue;
			}
		}

		var parent = effect.parent;
		effect = effect.next;

		while (effect === null && parent !== null) {
			effect = parent.next;
			parent = parent.parent;
		}
	}

	return effects;
}

/**
 * Synchronously flush any pending updates.
 * Returns void if no callback is provided, otherwise returns the result of calling the callback.
 * @template [T=void]
 * @param {(() => T) | undefined} [fn]
 * @returns {T}
 */
export function flushSync(fn) {
	var result;

	if (fn) {
		is_flushing = true;
		flush_queued_root_effects();

		is_flushing = true;
		result = fn();
	}

	while (true) {
		flush_tasks();

		if (queued_root_effects.length === 0) {
			// this would be reset in `flush_queued_root_effects` but since we are early returning here,
			// we need to reset it here as well in case the first time there's 0 queued root effects
			is_flushing = false;
			last_scheduled_effect = null;
			if (DEV) {
				dev_effect_stack = [];
			}
			return /** @type {T} */ (result);
		}

		is_flushing = true;
		flush_queued_root_effects();
	}
}

/**
 * Returns a promise that resolves once any pending state changes have been applied.
 * @returns {Promise<void>}
 */
export async function tick() {
	await Promise.resolve();
	// By calling flushSync we guarantee that any pending state changes are applied after one tick.
	// TODO look into whether we can make flushing subsequent updates synchronously in the future.
	flushSync();
}

/**
 * @template V
 * @param {Value<V>} signal
 * @returns {V}
 */
export function get(signal) {
	var flags = signal.f;
	var is_derived = (flags & DERIVED) !== 0;

	if (captured_signals !== null) {
		captured_signals.add(signal);
	}

	// Register the dependency on the current reaction signal.
	if (active_reaction !== null && !untracking) {
		if (
			source_ownership?.reaction !== active_reaction ||
			!source_ownership?.sources.includes(signal)
		) {
			var deps = active_reaction.deps;
			if (signal.rv < read_version) {
				signal.rv = read_version;
				// If the signal is accessing the same dependencies in the same
				// order as it did last time, increment `skipped_deps`
				// rather than updating `new_deps`, which creates GC cost
				if (new_deps === null && deps !== null && deps[skipped_deps] === signal) {
					skipped_deps++;
				} else if (new_deps === null) {
					new_deps = [signal];
				} else if (!skip_reaction || !new_deps.includes(signal)) {
					// Normally we can push duplicated dependencies to `new_deps`, but if we're inside
					// an unowned derived because skip_reaction is true, then we need to ensure that
					// we don't have duplicates
					new_deps.push(signal);
				}
			}
		}
	} else if (
		is_derived &&
		/** @type {Derived} */ (signal).deps === null &&
		/** @type {Derived} */ (signal).effects === null
	) {
		var derived = /** @type {Derived} */ (signal);
		var parent = derived.parent;

		if (parent !== null && (parent.f & UNOWNED) === 0) {
			// If the derived is owned by another derived then mark it as unowned
			// as the derived value might have been referenced in a different context
			// since and thus its parent might not be its true owner anymore
			derived.f ^= UNOWNED;
		}
	}

	if (is_derived && !is_destroying_effect) {
		derived = /** @type {Derived} */ (signal);

		if (check_dirtiness(derived)) {
			update_derived(derived);
		}
	}

	if (
		DEV &&
		tracing_mode_flag &&
		!untracking &&
		tracing_expressions !== null &&
		active_reaction !== null &&
		tracing_expressions.reaction === active_reaction
	) {
		// Used when mapping state between special blocks like `each`
		if (signal.trace) {
			signal.trace();
		} else {
			var trace = get_stack('TracedAt');

			if (trace) {
				var entry = tracing_expressions.entries.get(signal);

				if (entry === undefined) {
					entry = { traces: [] };
					tracing_expressions.entries.set(signal, entry);
				}

				var last = entry.traces[entry.traces.length - 1];

				// traces can be duplicated, e.g. by `snapshot` invoking both
				// both `getOwnPropertyDescriptor` and `get` traps at once
				if (trace.stack !== last?.stack) {
					entry.traces.push(trace);
				}
			}
		}
	}

	if (is_destroying_effect) {
		if (old_values.has(signal)) {
			return old_values.get(signal);
		}

		if (is_derived) {
			derived = /** @type {Derived} */ (signal);

			var value = derived.v;

			// if the derived is dirty, or depends on the values that just changed, re-execute
			if ((derived.f & CLEAN) !== 0 || depends_on_old_values(derived)) {
				value = execute_derived(derived);
			}

			old_values.set(derived, value);

			return value;
		}
	}

	return signal.v;
}

/** @param {Derived} derived */
function depends_on_old_values(derived) {
	if (derived.v === UNINITIALIZED) return true; // we don't know, so assume the worst
	if (derived.deps === null) return false;

	for (const dep of derived.deps) {
		if (old_values.has(dep)) {
			return true;
		}

		if ((dep.f & DERIVED) !== 0 && depends_on_old_values(/** @type {Derived} */ (dep))) {
			return true;
		}
	}

	return false;
}

/**
 * Like `get`, but checks for `undefined`. Used for `var` declarations because they can be accessed before being declared
 * @template V
 * @param {Value<V> | undefined} signal
 * @returns {V | undefined}
 */
export function safe_get(signal) {
	return signal && get(signal);
}

/**
 * Capture an array of all the signals that are read when `fn` is called
 * @template T
 * @param {() => T} fn
 */
function capture_signals(fn) {
	var previous_captured_signals = captured_signals;
	captured_signals = new Set();

	var captured = captured_signals;
	var signal;

	try {
		untrack(fn);
		if (previous_captured_signals !== null) {
			for (signal of captured_signals) {
				previous_captured_signals.add(signal);
			}
		}
	} finally {
		captured_signals = previous_captured_signals;
	}

	return captured;
}

/**
 * Invokes a function and captures all signals that are read during the invocation,
 * then invalidates them.
 * @param {() => any} fn
 */
export function invalidate_inner_signals(fn) {
	var captured = capture_signals(() => untrack(fn));

	for (var signal of captured) {
		internal_set(signal, signal.v);
	}
}

/**
 * When used inside a [`$derived`](https://svelte.dev/docs/svelte/$derived) or [`$effect`](https://svelte.dev/docs/svelte/$effect),
 * any state read inside `fn` will not be treated as a dependency.
 *
 * ```ts
 * $effect(() => {
 *   // this will run when `data` changes, but not when `time` changes
 *   save(data, {
 *     timestamp: untrack(() => time)
 *   });
 * });
 * ```
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function untrack(fn) {
	var previous_untracking = untracking;
	try {
		untracking = true;
		return fn();
	} finally {
		untracking = previous_untracking;
	}
}

const STATUS_MASK = ~(DIRTY | MAYBE_DIRTY | CLEAN);

/**
 * @param {Signal} signal
 * @param {number} status
 * @returns {void}
 */
export function set_signal_status(signal, status) {
	signal.f = (signal.f & STATUS_MASK) | status;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
export function exclude_from_object(obj, keys) {
	/** @type {Record<string, unknown>} */
	var result = {};

	for (var key in obj) {
		if (!keys.includes(key)) {
			result[key] = obj[key];
		}
	}

	return result;
}

/**
 * Possibly traverse an object and read all its properties so that they're all reactive in case this is `$state`.
 * Does only check first level of an object for performance reasons (heuristic should be good for 99% of all cases).
 * @param {any} value
 * @returns {void}
 */
export function deep_read_state(value) {
	if (typeof value !== 'object' || !value || value instanceof EventTarget) {
		return;
	}

	if (STATE_SYMBOL in value) {
		deep_read(value);
	} else if (!Array.isArray(value)) {
		for (let key in value) {
			const prop = value[key];
			if (typeof prop === 'object' && prop && STATE_SYMBOL in prop) {
				deep_read(prop);
			}
		}
	}
}

/**
 * Deeply traverse an object and read all its properties
 * so that they're all reactive in case this is `$state`
 * @param {any} value
 * @param {Set<any>} visited
 * @returns {void}
 */
export function deep_read(value, visited = new Set()) {
	if (
		typeof value === 'object' &&
		value !== null &&
		// We don't want to traverse DOM elements
		!(value instanceof EventTarget) &&
		!visited.has(value)
	) {
		visited.add(value);
		// When working with a possible SvelteDate, this
		// will ensure we capture changes to it.
		if (value instanceof Date) {
			value.getTime();
		}
		for (let key in value) {
			try {
				deep_read(value[key], visited);
			} catch (e) {
				// continue
			}
		}
		const proto = get_prototype_of(value);
		if (
			proto !== Object.prototype &&
			proto !== Array.prototype &&
			proto !== Map.prototype &&
			proto !== Set.prototype &&
			proto !== Date.prototype
		) {
			const descriptors = get_descriptors(proto);
			for (let key in descriptors) {
				const get = descriptors[key].get;
				if (get) {
					try {
						get.call(value);
					} catch (e) {
						// continue
					}
				}
			}
		}
	}
}
