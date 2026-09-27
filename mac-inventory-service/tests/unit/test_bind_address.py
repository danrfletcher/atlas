import unittest
from unittest.mock import MagicMock

from mac_inventory.bind_address import discover_local_ipv4_addresses, get_bind_address, select_tailscale_address


class SelectTailscaleAddressTests(unittest.TestCase):
    def test_picks_cgnat_address(self):
        self.assertEqual(
            select_tailscale_address(["192.168.1.5", "100.101.2.3", "10.0.0.1"]),
            "100.101.2.3",
        )

    def test_no_match_returns_none(self):
        self.assertIsNone(select_tailscale_address(["192.168.1.5", "10.0.0.1", "127.0.0.1"]))

    def test_ignores_invalid_addresses(self):
        self.assertEqual(select_tailscale_address(["not-an-ip", "100.64.0.1"]), "100.64.0.1")

    def test_range_boundaries(self):
        self.assertIsNone(select_tailscale_address(["100.63.255.255"]))
        self.assertEqual(select_tailscale_address(["100.64.0.0"]), "100.64.0.0")
        self.assertEqual(select_tailscale_address(["100.127.255.255"]), "100.127.255.255")
        self.assertIsNone(select_tailscale_address(["100.128.0.0"]))


class DiscoverLocalIpv4AddressesTests(unittest.TestCase):
    def test_parses_ifconfig_output(self):
        run = MagicMock(
            return_value=MagicMock(
                returncode=0,
                stdout=(
                    "en0: flags=8863<UP,BROADCAST> mtu 1500\n"
                    "\tinet 192.168.1.5 netmask 0xffffff00 broadcast 192.168.1.255\n"
                    "utun3: flags=80d1<UP,POINTOPOINT> mtu 1280\n"
                    "\tinet 100.101.2.3 netmask 0xffffffff\n"
                    "lo0: flags=8049<UP,LOOPBACK> mtu 16384\n"
                    "\tinet 127.0.0.1 netmask 0xff000000\n"
                ),
            )
        )
        self.assertEqual(
            discover_local_ipv4_addresses(run),
            ["192.168.1.5", "100.101.2.3", "127.0.0.1"],
        )
        run.assert_called_once_with(["ifconfig"])

    def test_command_failure_returns_empty(self):
        run = MagicMock(return_value=MagicMock(returncode=1, stdout=""))
        self.assertEqual(discover_local_ipv4_addresses(run), [])

    def test_run_exception_returns_empty(self):
        run = MagicMock(side_effect=OSError("no such binary"))
        self.assertEqual(discover_local_ipv4_addresses(run), [])


class GetBindAddressTests(unittest.TestCase):
    def test_raises_when_no_tailscale_address(self):
        run = MagicMock(return_value=MagicMock(returncode=0, stdout="inet 192.168.1.5\n"))
        with self.assertRaises(RuntimeError):
            get_bind_address(run)

    def test_returns_tailscale_address_never_wildcard_or_public(self):
        run = MagicMock(return_value=MagicMock(returncode=0, stdout="inet 192.168.1.5\ninet 100.64.9.9\n"))
        address = get_bind_address(run)
        self.assertEqual(address, "100.64.9.9")
        self.assertNotEqual(address, "0.0.0.0")
        self.assertNotEqual(address, "192.168.1.5")


if __name__ == "__main__":
    unittest.main()
