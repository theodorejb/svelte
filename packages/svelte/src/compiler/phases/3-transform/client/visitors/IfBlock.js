/** @import { BlockStatement, Expression } from 'estree' */
/** @import { AST } from '#compiler' */
/** @import { ComponentContext } from '../types' */
import * as b from '#compiler/builders';
import { build_expression, add_svelte_meta } from './shared/utils.js';

/**
 * @param {AST.IfBlock} node
 * @param {ComponentContext} context
 */
export function IfBlock(node, context) {
	context.state.template.push_comment();
	const statements = [];

	const consequent = /** @type {BlockStatement} */ (context.visit(node.consequent));
	const consequent_id = context.state.scope.generate('consequent');

	statements.push(b.var(b.id(consequent_id), b.arrow([b.id('$$anchor')], consequent)));

	let alternate_id;

	if (node.alternate) {
		alternate_id = context.state.scope.generate('alternate');
		const alternate = /** @type {BlockStatement} */ (context.visit(node.alternate));
		const nodes = node.alternate.nodes;

		let alternate_args = [b.id('$$anchor')];
		if (nodes.length === 1 && nodes[0].type === 'IfBlock' && nodes[0].elseif) {
			alternate_args.push(b.id('$$elseif'));
		}

		statements.push(b.var(b.id(alternate_id), b.arrow(alternate_args, alternate)));
	}

	const test = build_expression(context, node.test, node.metadata.expression);

	/** @type {Expression[]} */
	const args = [
		node.elseif ? b.id('$$anchor') : context.state.node,
		b.arrow(
			[b.id('$$render')],
			b.block([
				b.if(
					test,
					b.stmt(b.call(b.id('$$render'), b.id(consequent_id))),
					alternate_id ? b.stmt(b.call(b.id('$$render'), b.id(alternate_id), b.false)) : undefined
				)
			])
		)
	];

	if (node.elseif) {
		// We treat this...
		//
		//   {#if x}
		//     ...
		//   {:else}
		//     {#if y}
		//       <div transition:foo>...</div>
		//     {/if}
		//   {/if}
		//
		// ...slightly differently to this...
		//
		//   {#if x}
		//     ...
		//   {:else if y}
		//     <div transition:foo>...</div>
		//   {/if}
		//
		// ...even though they're logically equivalent. In the first case, the
		// transition will only play when `y` changes, but in the second it
		// should play when `x` or `y` change — both are considered 'local'
		args.push(b.id('$$elseif'));
	}

	statements.push(add_svelte_meta(b.call('$.if', ...args), node, 'if'));

	context.state.init.push(b.block(statements));
}
