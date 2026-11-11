package com.dsh.lan;

import android.util.Log;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Finds the gateway on the local network.
 *
 * The whole point: an address written into a QR code or typed by the operator
 * becomes wrong the moment the phone joins a different network. Here the phone
 * asks the network instead, so the answer is always the address that works
 * right now.
 *
 *   phone  --broadcast--> 255.255.255.255:<port>  {"probe":"dsh-phone-gateway"}
 *   gateway --unicast-->  the phone's socket      {"service":"dsh-phone-gateway","url":"http://..."}
 *
 * Broadcasts are sent to the global address AND to every interface's own subnet
 * broadcast address: some Android builds and some hotspots drop the global one,
 * and a per-interface send also picks the right radio when WiFi and mobile data
 * are both up.
 */
final class Discovery {

    private static final String TAG = "DshLan";

    /** Matches lib/discovery.js DISCOVERY_PORT. */
    static final int DISCOVERY_PORT = 8792;

    /** Matches lib/discovery.js DISCOVERY_SERVICE. */
    static final String SERVICE = "dsh-phone-gateway";

    private Discovery() {
    }

    /** One gateway the discovery sweep found. */
    static final class Found {
        final String url;
        final String address;

        Found(String url, String address) {
            this.url = url;
            this.address = address;
        }

        @Override
        public String toString() {
            return url;
        }
    }

    /**
     * Broadcast and collect replies until the timeout expires.
     *
     * Runs on a caller-provided background thread: Android forbids network work
     * on the UI thread and this call blocks for up to {@code timeoutMs}.
     *
     * @param timeoutMs how long to listen, in milliseconds.
     * @return every distinct gateway that answered, possibly empty.
     */
    static List<Found> discover(int timeoutMs) {
        final List<Found> found = new ArrayList<>();
        final Set<String> seen = new LinkedHashSet<>();
        DatagramSocket socket = null;

        try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
            // A short receive timeout keeps the loop responsive to cancellation
            // and to the overall deadline.
            socket.setSoTimeout(250);

            final byte[] query = ("{\"probe\":\"" + SERVICE + "\"}").getBytes("UTF-8");
            for (InetAddress target : broadcastTargets()) {
                try {
                    socket.send(new DatagramPacket(query, query.length, target, DISCOVERY_PORT));
                } catch (Exception perTarget) {
                    // One interface refusing a broadcast must not abort the sweep.
                    Log.d(TAG, "broadcast to " + target + " failed: " + perTarget.getMessage());
                }
            }

            final long deadline = System.currentTimeMillis() + timeoutMs;
            final byte[] buffer = new byte[1024];
            while (System.currentTimeMillis() < deadline) {
                final DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (java.net.SocketTimeoutException nothing) {
                    continue;
                } catch (Exception broken) {
                    Log.d(TAG, "receive failed: " + broken.getMessage());
                    break;
                }
                try {
                    final String text = new String(packet.getData(), 0, packet.getLength(), "UTF-8");
                    final JSONObject reply = new JSONObject(text);
                    if (!SERVICE.equals(reply.optString("service"))) {
                        continue;
                    }
                    final String url = reply.optString("url");
                    if (!url.startsWith("http://")) {
                        continue;
                    }
                    if (seen.add(url)) {
                        found.add(new Found(url, reply.optString("address")));
                    }
                } catch (Exception ignored) {
                    // A stray datagram from another service is not an error.
                }
            }
        } catch (Exception failure) {
            Log.w(TAG, "discovery failed: " + failure.getMessage());
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                    // closing a broken socket is not interesting
                }
            }
        }

        return found;
    }

    /**
     * The broadcast addresses worth trying.
     *
     * The global 255.255.255.255 comes first because it is the only one that
     * works on networks that do not report interface broadcast addresses; the
     * per-interface values follow because they survive a platform that drops the
     * global broadcast on a specific radio.
     */
    private static List<InetAddress> broadcastTargets() {
        final Set<String> unique = new LinkedHashSet<>();
        final List<InetAddress> targets = new ArrayList<>();

        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (nic == null || !nic.isUp() || nic.isLoopback()) {
                    continue;
                }
                for (InterfaceAddress entry : nic.getInterfaceAddresses()) {
                    final InetAddress broadcast = entry.getBroadcast();
                    if (broadcast instanceof Inet4Address && unique.add(broadcast.getHostAddress())) {
                        targets.add(broadcast);
                    }
                }
            }
        } catch (Exception ignored) {
            // Interface enumeration is best effort; the global broadcast remains.
        }

        try {
            final InetAddress global = InetAddress.getByName("255.255.255.255");
            if (unique.add(global.getHostAddress())) {
                targets.add(0, global);
            }
        } catch (Exception ignored) {
            // Nothing else to try.
        }

        if (targets.isEmpty()) {
            try {
                targets.add(InetAddress.getByName("255.255.255.255"));
            } catch (Exception ignored) {
                // Left empty; the caller reports that nothing was found.
            }
        }

        return targets;
    }
}
