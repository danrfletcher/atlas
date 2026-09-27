import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from mac_inventory.procrun import run_command
from mac_inventory.scanners import scan_apps, scan_cli, scan_launch_agents
from tests.fixtures.stubs import FIXTURES_DIR, install_stub_tools


class StubToolsTestCase(unittest.TestCase):
    """Puts stub brew/mas/plutil executables first on PATH, per the spec's fixture note."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        bin_dir = self.tmp_path / "bin"
        install_stub_tools(bin_dir)

        self._old_path = os.environ.get("PATH", "")
        self._old_fixtures = os.environ.get("MAC_INVENTORY_TEST_FIXTURES")
        # Stubs go first on PATH (per the spec's fixture note) so they shadow any real
        # brew/mas/plutil; basename/dirname/cat inside the stub scripts still need the
        # rest of PATH to resolve.
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{self._old_path}"
        os.environ["MAC_INVENTORY_TEST_FIXTURES"] = str(FIXTURES_DIR)

    def tearDown(self):
        os.environ["PATH"] = self._old_path
        if self._old_fixtures is None:
            os.environ.pop("MAC_INVENTORY_TEST_FIXTURES", None)
        else:
            os.environ["MAC_INVENTORY_TEST_FIXTURES"] = self._old_fixtures
        self._tmp.cleanup()

    def _make_app(self, apps_dir: Path, bundle_name: str, subdir: str = "") -> None:
        bundle_dir = apps_dir / subdir / f"{bundle_name}.app" if subdir else apps_dir / f"{bundle_name}.app"
        info_path = bundle_dir / "Contents" / "Info.plist"
        info_path.parent.mkdir(parents=True, exist_ok=True)
        info_path.write_text("placeholder -- the stub plutil ignores real content and keys off the bundle name")

    def _make_launch_agent(self, directory: Path, plist_name: str) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{plist_name}.plist").write_text("placeholder -- the stub plutil keys off the filename")


class ScanAppsTests(StubToolsTestCase):
    def test_shape_and_g16_style_directory_merge(self):
        apps_dir = self.tmp_path / "Applications"
        system_apps_dir = self.tmp_path / "SystemApplications"  # a missing dir is skipped, not fatal
        self._make_app(apps_dir, "Docker")
        self._make_app(apps_dir, "UnicodeApp")

        items = scan_apps(run=run_command, directories=[apps_dir, system_apps_dir])

        self.assertEqual(len(items), 2)
        for item in items:
            self.assertEqual(set(item.keys()), {"id", "label", "version", "path"})
        docker = next(i for i in items if i["id"] == "com.docker.docker")
        self.assertEqual(docker["label"], "Docker")
        self.assertEqual(docker["version"], "4.34.0")
        self.assertTrue(docker["path"].endswith("Docker.app"))

    def test_missing_bundle_id_is_skipped_not_fatal(self):
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "NoBundleId")
        self._make_app(apps_dir, "Docker")

        items = scan_apps(run=run_command, directories=[apps_dir])
        self.assertEqual([i["id"] for i in items], ["com.docker.docker"])

    def test_unicode_names_and_paths_round_trip(self):
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "UnicodeApp")

        items = scan_apps(run=run_command, directories=[apps_dir])
        self.assertEqual(items[0]["label"], "Café – Résumé")

    def test_unreadable_directory_is_skipped_not_fatal(self):
        missing = self.tmp_path / "does-not-exist"
        items = scan_apps(run=run_command, directories=[missing])
        self.assertEqual(items, [])

    def test_malformed_plist_is_skipped_not_fatal(self):
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "NoFixtureForThisOne")
        self._make_app(apps_dir, "Docker")

        items = scan_apps(run=run_command, directories=[apps_dir])
        self.assertEqual([i["id"] for i in items], ["com.docker.docker"])

    def test_finds_apps_nested_in_subfolders(self):
        # R9: Utilities folders and vendor folders put .app bundles a level or more
        # below /Applications; a direct-children-only scan misses them entirely.
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "Docker")
        self._make_app(apps_dir, "Foo", subdir="Vendor")

        items = scan_apps(run=run_command, directories=[apps_dir])

        ids = {i["id"] for i in items}
        self.assertIn("com.docker.docker", ids)
        nested = next(i for i in items if i["id"] == "com.vendor.foo")
        self.assertTrue(nested["path"].endswith(str(Path("Vendor") / "Foo.app")))

    def test_does_not_descend_into_app_bundle_contents(self):
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "Docker")
        # A file living inside the bundle's own Contents dir must never be treated
        # as a nested app to scan into.
        (apps_dir / "Docker.app" / "Contents" / "Resources" / "Nested.app").mkdir(parents=True)

        items = scan_apps(run=run_command, directories=[apps_dir])
        self.assertEqual([i["id"] for i in items], ["com.docker.docker"])

    def test_runner_level_plutil_failure_raises_instead_of_emptying_apps(self):
        # R10: a missing or hung plutil is a runner-level failure, not a bad file --
        # it must raise so the cache keeps its last good snapshot rather than being
        # silently emptied.
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "Docker")

        def missing_plutil(argv, timeout=None):
            raise FileNotFoundError("plutil not found")

        with self.assertRaises(Exception):
            scan_apps(run=missing_plutil, directories=[apps_dir])

    def test_hung_plutil_raises_instead_of_emptying_apps(self):
        apps_dir = self.tmp_path / "Applications"
        self._make_app(apps_dir, "Docker")

        def hung_plutil(argv, timeout=None):
            raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout or 10)

        with self.assertRaises(Exception):
            scan_apps(run=hung_plutil, directories=[apps_dir])


class ScanLaunchAgentsTests(StubToolsTestCase):
    def test_g16_merges_three_directories(self):
        user_agents = self.tmp_path / "LaunchAgents"
        system_agents = self.tmp_path / "SystemLaunchAgents"
        daemons = self.tmp_path / "LaunchDaemons"  # left absent: a missing dir is skipped
        self._make_launch_agent(user_agents, "com.apple.foo")
        self._make_launch_agent(system_agents, "com.example.dup")

        items = scan_launch_agents(run=run_command, directories=[user_agents, system_agents, daemons])

        self.assertEqual({i["id"] for i in items}, {"com.apple.foo", "com.example.dup"})
        for item in items:
            self.assertEqual(set(item.keys()), {"id", "label", "version", "path"})

    def test_duplicate_label_across_directories_first_wins(self):
        user_agents = self.tmp_path / "LaunchAgents"
        system_agents = self.tmp_path / "SystemLaunchAgents"
        self._make_launch_agent(user_agents, "com.apple.foo")
        self._make_launch_agent(system_agents, "com.apple.foo")  # same Label, different file

        items = scan_launch_agents(run=run_command, directories=[user_agents, system_agents])
        matching = [i for i in items if i["id"] == "com.apple.foo"]
        self.assertEqual(len(matching), 1)
        self.assertTrue(matching[0]["path"].startswith(str(user_agents)))

    def test_missing_label_is_skipped_not_fatal(self):
        agents = self.tmp_path / "LaunchAgents"
        self._make_launch_agent(agents, "nolabel")
        self._make_launch_agent(agents, "com.apple.foo")

        items = scan_launch_agents(run=run_command, directories=[agents])
        self.assertEqual([i["id"] for i in items], ["com.apple.foo"])

    def test_malformed_plist_is_skipped_not_fatal(self):
        agents = self.tmp_path / "LaunchAgents"
        self._make_launch_agent(agents, "not-a-real-plist")
        self._make_launch_agent(agents, "com.apple.foo")

        items = scan_launch_agents(run=run_command, directories=[agents])
        self.assertEqual([i["id"] for i in items], ["com.apple.foo"])

    def test_runner_level_plutil_failure_raises_instead_of_emptying_launch_agents(self):
        # R10: same runner-level-vs-per-file distinction as scan_apps, for the
        # launch-agents scan.
        agents = self.tmp_path / "LaunchAgents"
        self._make_launch_agent(agents, "com.apple.foo")

        def missing_plutil(argv, timeout=None):
            raise FileNotFoundError("plutil not found")

        with self.assertRaises(Exception):
            scan_launch_agents(run=missing_plutil, directories=[agents])


class ScanCliTests(StubToolsTestCase):
    def test_covers_brew_formula_cask_and_mas(self):
        items = scan_cli(run=run_command)
        ids = {i["id"] for i in items}
        self.assertIn("brew:git", ids)
        self.assertIn("brew:docker", ids)  # docker the formula
        self.assertIn("brew-cask:docker", ids)  # docker the cask -- distinct id (R6)
        self.assertIn("mas:Keynote", ids)
        for item in items:
            self.assertEqual(set(item.keys()), {"id", "label", "version", "path"})

    def test_formula_and_cask_sharing_a_name_both_survive(self):
        # R6: brew:docker (the CLI formula) and brew-cask:docker (Docker Desktop)
        # must not collide on the same id, and neither should silently drop.
        items = scan_cli(run=run_command)
        formula = next(i for i in items if i["id"] == "brew:docker")
        cask = next(i for i in items if i["id"] == "brew-cask:docker")
        self.assertEqual(formula["version"], "24.0.0")
        self.assertEqual(cask["label"], "Docker")
        self.assertEqual(cask["version"], "4.34.0")

    def test_uninstalled_manager_contributes_nothing_and_does_not_fail(self):
        # Remove the mas stub from PATH; brew items should still come back.
        bin_dir = self.tmp_path / "bin"
        (bin_dir / "mas").unlink()

        items = scan_cli(run=run_command)
        ids = {i["id"] for i in items}
        self.assertIn("brew:git", ids)
        self.assertFalse(any(i.startswith("mas:") for i in ids))

    def test_installed_managers_failure_raises_instead_of_emptying_the_list(self):
        # R1: an installed brew that fails or times out must raise, not return [],
        # so the cache keeps its last good snapshot rather than being emptied.
        bin_dir = self.tmp_path / "bin"
        failing_brew = bin_dir / "brew"
        failing_brew.write_text("#!/bin/sh\nexit 1\n")
        failing_brew.chmod(failing_brew.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        with self.assertRaises(Exception):
            scan_cli(run=run_command)


if __name__ == "__main__":
    unittest.main()
