import unittest

from mac_inventory.ids import dedup_items, derive_app_id, derive_cli_id, derive_launch_agent_id


class DeriveAppIdTests(unittest.TestCase):
    def test_table(self):
        cases = [
            ({"CFBundleIdentifier": "com.docker.docker"}, "com.docker.docker"),
            ({"CFBundleIdentifier": ""}, None),
            ({}, None),
            ({"CFBundleIdentifier": 42}, None),
            ({"CFBundleIdentifier": None}, None),
        ]
        for info, expected in cases:
            with self.subTest(info=info):
                self.assertEqual(derive_app_id(info), expected)


class DeriveCliIdTests(unittest.TestCase):
    def test_table(self):
        cases = [
            (("brew", "git"), "brew:git"),
            (("mas", "Xcode"), "mas:Xcode"),
            (("brew", ""), None),
            (("", "git"), None),
            (("", ""), None),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(derive_cli_id(*args), expected)


class DeriveLaunchAgentIdTests(unittest.TestCase):
    def test_table(self):
        cases = [
            ({"Label": "com.apple.foo"}, "com.apple.foo"),
            ({"Label": ""}, None),
            ({}, None),
            ({"Label": None}, None),
            ({"Label": 7}, None),
        ]
        for plist, expected in cases:
            with self.subTest(plist=plist):
                self.assertEqual(derive_launch_agent_id(plist), expected)


class DedupItemsTests(unittest.TestCase):
    def test_skips_missing_ids_and_keeps_first_on_duplicate(self):
        items = [
            {"id": "a", "label": "first"},
            {"id": "a", "label": "second"},
            {"id": None, "label": "no id"},
            {"id": "", "label": "empty id"},
            {"id": "b", "label": "b"},
        ]
        result = dedup_items(items)
        self.assertEqual([item["id"] for item in result], ["a", "b"])
        self.assertEqual(result[0]["label"], "first")

    def test_empty_input(self):
        self.assertEqual(dedup_items([]), [])


if __name__ == "__main__":
    unittest.main()
