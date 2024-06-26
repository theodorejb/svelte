import { assert_ok, test } from '../../test';

export default test({
	server_props: {
		items: []
	},

	props: {
		items: [{ name: 'a' }]
	},

	snapshot(target) {
		const ul = target.querySelector('ul');
		assert_ok(ul);

		return {
			ul
		};
	}
});
