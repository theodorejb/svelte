import { flushSync } from 'svelte';
import { test } from '../../test';

export default test({
	html: `<button>0</button>`,

	test({ assert, target }) {
		const btn = target.querySelector('button');

		btn?.click();
		flushSync();
		assert.htmlEqual(target.innerHTML, `<button>0</button>`);

		btn?.click();
		flushSync();
		assert.htmlEqual(target.innerHTML, `<button>0</button>`);
	}
});
