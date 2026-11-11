package com.dsh.lan;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.List;

/**
 * The phone shell around the gateway's web UI.
 *
 * Lifecycle per launch:
 *   1. broadcast for the gateway (UDP 8792) — no address is ever assumed
 *   2. on a reply, load the reported URL in a WebView
 *   3. on no reply, show a manual-address screen (the last good address is
 *      pre-filled, so a LAN discovery failure is not a dead end)
 *
 * Three things the WebView cannot do on its own, done natively:
 *   - theme follow: the DSH theme preference lives in the Host settings
 *     document and `system` resolves through `prefers-color-scheme`, which in a
 *     WebView reports the Android night setting. Pinning the WebView's own
 *     night mode to the DESKTOP's scheme keeps the phone matching the computer.
 *   - text size: fixed-pixel frontend, so `WebSettings.setTextZoom` scales the
 *     document. Always reachable from the floating gear, not just at startup.
 *   - file and photo upload: `onShowFileChooser` is only called when the app
 *     supplies it, so it bridges to the system picker.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh-phone-gateway";
    private static final String KEY_LAST_URL = "lastUrl";
    private static final String KEY_TEXT_ZOOM = "textZoom";
    private static final String KEY_NIGHT = "nightMode";

    /**
     * The gateway's device credential, kept here so a pairing survives a network
     * change. A browser cookie is host-scoped and the machine's address moves; this
     * value is re-issued against whatever address discovery returns.
     */
    private static final String KEY_DEVICE_COOKIE = "deviceCookie";
    /** Mirrors DEVICE_COOKIE in dsh-phone-gateway/lib/pair.js. */
    private static final String DEVICE_COOKIE_PREFIX = "dsh-phone-gateway-device=";
    /** The gateway listens here; mirrors `port` in its config. */
    private static final String GATEWAY_PORT = ":8791";
    /** Replayed cookie lifetime; the server enforces the real expiry itself. */
    private static final int COOKIE_MAX_AGE_SECONDS = 15552000;

    /** How long to listen for a discovery reply before giving up. */
    private static final int DISCOVERY_TIMEOUT_MS = 2500;

    /**
     * Minimum gap between automatic re-discoveries.
     *
     * One network change produces several connectivity callbacks, and a failed page
     * load produces another; each discovery waits seconds for a broadcast reply, so
     * they are collapsed into one attempt.
     */
    private static final long RECONNECT_DEBOUNCE_MS = 4000;

    /** How often the loaded host is probed for reachability. */
    private static final long HEARTBEAT_INTERVAL_MS = 5000;

    /** TCP connect timeout for one heartbeat probe. */
    private static final int HEARTBEAT_TIMEOUT_MS = 1500;

    /**
     * Failed probes in a row before reconnecting.
     *
     * Two, not one: a single timeout happens on a busy router while the connection is
     * still perfectly usable, and reconnecting throws away the page for nothing.
     */
    private static final int HEARTBEAT_FAILURES_BEFORE_RECONNECT = 2;

    /** Default document scale; the frontend is a desktop layout at 100%. */
    private static final int DEFAULT_TEXT_ZOOM = 165;

    /**
     * Allowed document scale range, as a percentage.
     *
     * `WebSettings.setTextZoom` accepts any integer, so the cap is a product choice:
     * past roughly 350% the desktop layout the frontend ships stops reflowing and the
     * content simply runs off the side.
     */
    private static final int MIN_TEXT_ZOOM = 100;
    private static final int MAX_TEXT_ZOOM = 350;

    /** 0 = light (matches the desktop default), 1 = dark. */
    private static final int NIGHT_LIGHT = 0;
    private static final int NIGHT_DARK = 1;

    private static final int REQUEST_FILE_PICKER = 1001;

    /**
     * User-Agent marker appended by this app. The gateway pairs it with a
     * "hide the download card" decision — inside the app there is nothing left to
     * install.
     */
    private static final String APP_UA_TAG = "DSHLanApp";

    /** The app's own upload button, which feeds the composer directly. */
    private static final int REQUEST_COMPOSER_PICKER = 1002;

    private FrameLayout root;
    private WebView web;
    private SharedPreferences prefs;

    /** The ⚙ / ＋ overlay; hidden on pages that are not the app itself. */
    private View floatingControls;

    /** Set once a gateway page (pairing / "device in use") has been shown. */
    private boolean sawNonAppPage;

    /** Watches for a network change so the app can re-discover instead of retrying. */
    private ConnectivityManager.NetworkCallback networkCallback;
    /** Guards against stacking discovery threads. */
    private boolean discoveryInFlight;
    /** `SystemClock.elapsedRealtime()` of the last automatic re-discovery. */
    private long lastReconnectAt;
    /** Drives the reachability probe while a page is on screen. */
    private Handler heartbeatHandler;
    private Runnable heartbeatTask;
    /** Consecutive failed probes; resets on any success. */
    private int heartbeatFailures;
    /** True while a probe's connect is outstanding, so the next tick does not stack. */
    private boolean probeInFlight;

    /** Pending `onShowFileChooser` callback, resolved by the picker result. */
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        root = new FrameLayout(this);
        setContentView(root);

        if (state != null) {
            final String saved = state.getString("currentUrl");
            registerNetworkWatcher();
            if (saved != null) {
                showWebView(saved);
                return;
            }
            startDiscovery();
            return;
        }
        registerNetworkWatcher();
        startDiscovery();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (web != null) {
            state.putString("currentUrl", web.getUrl());
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // The page theme is re-applied after each load, and a rotation keeps the
        // same WebView, so nothing needs re-applying here.
    }

    // ---------------------------------------------------------------- discovery

    /** Broadcast on a background thread, then act on the result. */
    private void startDiscovery() {
        root.removeAllViews();
        root.addView(buildSearchingView());

        new Thread(() -> {
            final List<Discovery.Found> found = Discovery.discover(DISCOVERY_TIMEOUT_MS);
            runOnUiThread(() -> {
                if (isFinishing()) {
                    return;
                }
                if (!found.isEmpty()) {
                    final String url = found.get(0).url;
                    prefs.edit().putString(KEY_LAST_URL, url).apply();
                    showWebView(url);
                } else {
                    showManualEntry();
                }
            });
        }, "dsh-discovery").start();
    }

    // ------------------------------------------------------- staying connected

    /**
     * Watch the network so a change is noticed while the app is open.
     *
     * This is a fast path only. It is NOT reliable on its own: `onAvailable` fires
     * at start-up as well, some transitions report the same network twice, and a
     * device that merely moves between subnets can keep the same default network.
     * The heartbeat below is the path that actually notices a dead host.
     */
    private void registerNetworkWatcher() {
        try {
            final ConnectivityManager manager =
                    (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (manager == null) {
                return;
            }
            final NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    scheduleReconnect();
                }

                @Override
                public void onLost(Network network) {
                    scheduleReconnect();
                }
            };
            manager.registerNetworkCallback(request, networkCallback);
        } catch (Exception ignored) {
            // Without the watcher the manual "重新查找" button still works.
        }
    }

    /**
     * Re-discover and reconnect, at most once per debounce window.
     *
     * A network change fires several callbacks in a burst (lost, available,
     * capabilities), and each discovery waits seconds for a broadcast reply, so the
     * calls are collapsed instead of stacking threads.
     */
    private void scheduleReconnect() {
        if (isFinishing()) {
            return;
        }
        if (discoveryInFlight) {
            return;
        }
        final long now = SystemClock.elapsedRealtime();
        if (now - lastReconnectAt < RECONNECT_DEBOUNCE_MS) {
            return;
        }
        lastReconnectAt = now;
        reconnectToHost();
    }

    /**
     * Ask the network who is hosting the gateway, and go there.
     *
     * This is the whole fix for "switching networks requires restarting the app":
     * the old address is abandoned as soon as discovery names a new one, and when
     * nothing answers the operator gets a screen that says what to check.
     */
    private void reconnectToHost() {
        if (isFinishing() || discoveryInFlight) {
            return;
        }
        discoveryInFlight = true;
        // Drop the dead page first: it also stops the heartbeat, which only probes
        // while a page is on screen, so the search is not interrupted by it.
        destroyWebView();
        root.removeAllViews();
        root.addView(buildSearchingView());

        new Thread(() -> {
            final List<Discovery.Found> found = Discovery.discover(DISCOVERY_TIMEOUT_MS);
            runOnUiThread(() -> {
                discoveryInFlight = false;
                if (isFinishing()) {
                    return;
                }
                if (found.isEmpty()) {
                    showConnectionLost();
                    return;
                }
                final String url = found.get(0).url;
                prefs.edit().putString(KEY_LAST_URL, url).apply();
                showWebView(url);
            });
        }, "dsh-rediscovery").start();
    }

    // ---------------------------------------------------------------- heartbeat

    /**
     * Probe the loaded host every few seconds and reconnect when it disappears.
     *
     * Neither signal above can be trusted alone. `onReceivedError` only fires for a
     * load that is happening — a page that is merely OPEN never produces one — and
     * the connectivity callbacks miss the case where the phone keeps the same
     * default network but the computer's address moved. A plain TCP probe of the
     * address the page is using answers the only question that matters: is it still
     * there?
     *
     * Runs only while a page is on screen and the app is in the foreground.
     */
    private void startHeartbeat() {
        if (heartbeatHandler == null) {
            heartbeatHandler = new Handler(Looper.getMainLooper());
        }
        if (heartbeatTask != null) {
            return;
        }
        heartbeatTask = new Runnable() {
            @Override
            public void run() {
                probeHostReachable();
                if (heartbeatHandler != null) {
                    heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
                }
            }
        };
        heartbeatHandler.postDelayed(heartbeatTask, HEARTBEAT_INTERVAL_MS);
    }

    private void stopHeartbeat() {
        if (heartbeatHandler != null && heartbeatTask != null) {
            heartbeatHandler.removeCallbacks(heartbeatTask);
        }
        heartbeatTask = null;
    }

    /** One reachability probe of the address the current page was loaded from. */
    private void probeHostReachable() {
        // Nothing to watch while a search or a reconnect is already running.
        if (isFinishing() || web == null || discoveryInFlight || probeInFlight) {
            return;
        }
        final String url = prefs.getString(KEY_LAST_URL, "");
        if (!isGatewayUrl(url)) {
            return;
        }
        final Uri parsed = Uri.parse(url);
        final String host = parsed.getHost();
        final int port = parsed.getPort();
        if (host == null || port <= 0) {
            return;
        }
        // One probe at a time: a blackholed address holds the connect for the full
        // timeout, and the next tick must not stack another thread on top of it.
        probeInFlight = true;
        new Thread(() -> {
            boolean reachable = false;
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), HEARTBEAT_TIMEOUT_MS);
                reachable = true;
            } catch (Exception ignored) {
                // A refused or timed-out connect is exactly the signal we want.
            }
            final boolean ok = reachable;
            runOnUiThread(() -> {
                probeInFlight = false;
                if (isFinishing()) {
                    return;
                }
                if (ok) {
                    heartbeatFailures = 0;
                    return;
                }
                heartbeatFailures += 1;
                if (heartbeatFailures < HEARTBEAT_FAILURES_BEFORE_RECONNECT) {
                    return;
                }
                heartbeatFailures = 0;
                // The address is provably dead, so the debounce must not swallow this.
                lastReconnectAt = 0;
                reconnectToHost();
            });
        }, "dsh-heartbeat").start();
    }

    /**
     * The "nothing answered" screen.
     *
     * Says the two things that are actually true when this happens: one of the two
     * devices changed networks, and they are no longer on the same one.
     */
    private void showConnectionLost() {        if (isFinishing()) {
            return;
        }
        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(dp(28), dp(28), dp(28), dp(28));
        column.setBackgroundColor(isDarkTheme() ? Color.rgb(15, 17, 21) : Color.WHITE);

        final TextView title = new TextView(this);
        title.setText("连接已断开");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(shellTextColor());
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(10));
        column.addView(title);

        final TextView hint = new TextView(this);
        hint.setText("没有找到电脑。手机或电脑的网络可能已经改变。\n"
                + "请检查两者是否连在同一个 Wi-Fi 或热点下，然后重试。");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setTextColor(shellMutedColor());
        hint.setGravity(Gravity.CENTER);
        column.addView(hint);

        final String last = prefs.getString(KEY_LAST_URL, "");
        if (!last.isEmpty()) {
            final TextView lastUrl = new TextView(this);
            lastUrl.setText("上次连接：" + last);
            lastUrl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            lastUrl.setTextColor(shellMutedColor());
            lastUrl.setGravity(Gravity.CENTER);
            lastUrl.setPadding(0, dp(10), 0, 0);
            column.addView(lastUrl);
        }

        final Button retry = new Button(this);
        retry.setText("重新查找");
        retry.setOnClickListener(clicked -> {
            // Bypass the debounce: this is an explicit request.
            lastReconnectAt = 0;
            reconnectToHost();
        });
        final LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(24);
        column.addView(retry, retryParams);

        final Button manual = new Button(this);
        manual.setText("手动输入地址");
        manual.setOnClickListener(clicked -> showManualEntry());
        final LinearLayout.LayoutParams manualParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        manualParams.topMargin = dp(8);
        column.addView(manual, manualParams);

        root.removeAllViews();
        root.addView(column);
    }

    /** The "looking for your computer" screen, with an escape hatch. */
    private View buildSearchingView() {
        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(dp(28), dp(28), dp(28), dp(28));
        column.setBackgroundColor(isDarkTheme() ? Color.rgb(15, 17, 21) : Color.WHITE);

        column.addView(new ProgressBar(this));

        final TextView title = new TextView(this);
        title.setText("正在查找电脑…");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(shellTextColor());
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(20), 0, dp(8));
        column.addView(title);

        final TextView hint = new TextView(this);
        hint.setText("请确认手机和电脑在同一个网络（同一热点）");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setTextColor(shellMutedColor());
        hint.setGravity(Gravity.CENTER);
        column.addView(hint);

        final Button manual = new Button(this);
        manual.setText("手动输入地址");
        manual.setOnClickListener(clicked -> showManualEntry());
        final LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(24);
        column.addView(manual, params);

        return column;
    }

    /** Last-resort address entry, pre-filled with the last address that worked. */
    private void showManualEntry() {
        if (isFinishing()) {
            return;
        }
        final ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(isDarkTheme() ? Color.rgb(15, 17, 21) : Color.WHITE);

        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(24), dp(48), dp(24), dp(24));
        scroll.addView(column);

        final TextView title = new TextView(this);
        title.setText("连接到电脑");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(shellTextColor());
        column.addView(title);

        final TextView hint = new TextView(this);
        hint.setText("在电脑上打开 http://127.0.0.1:8791/__lan/status 查看地址。\n"
                // No sample address here: the machine's LAN address changes with
                // every network, so a printed example is wrong more often than right.
                + "格式：http://<电脑的局域网IP>:8791");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setTextColor(shellMutedColor());
        hint.setPadding(0, dp(8), 0, dp(16));
        column.addView(hint);

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(prefs.getString(KEY_LAST_URL, "http://"));
        input.setSelection(input.getText().length());
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input.setTextColor(shellTextColor());
        column.addView(input);

        final Button connect = new Button(this);
        connect.setText("连接");
        connect.setOnClickListener(clicked -> {
            String url = input.getText().toString().trim();
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://" + url;
            }
            if (url.matches("^https?://[^/:]+$")) {
                url = url + ":8791";
            }
            prefs.edit().putString(KEY_LAST_URL, url).apply();
            showWebView(url);
        });
        final LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = dp(16);
        column.addView(connect, buttonParams);

        final Button retry = new Button(this);
        retry.setText("重新搜索");
        retry.setOnClickListener(clicked -> startDiscovery());
        column.addView(retry, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.removeAllViews();
        root.addView(scroll);
    }

    // ------------------------------------------------------------------ webview

    /**
     * Release the current WebView, if any.
     *
     * Called before building a new one (re-discovery) and on destroy. A WebView that
     * is only detached keeps its renderer alive.
     */
    private void destroyWebView() {
        if (web == null) {
            return;
        }
        try {
            final ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
        } catch (Exception ignored) {
            // Destroying twice or after a crash is not worth reporting.
        }
        web = null;
    }

    private void showWebView(String url) {
        if (isFinishing()) {
            return;
        }

        // Re-discovery calls this again, so the previous WebView has to go — a
        // detached one keeps its renderer and its timers alive.
        destroyWebView();

        final FrameLayout container = new FrameLayout(this);

        web = new WebView(this);
        final WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setTextZoom(zoom());
        CookieManager.getInstance().setAcceptCookie(true);

        // Mark our own traffic in the User-Agent. The gateway uses this to tell
        // "already inside the app" from "a phone browser", and therefore whether
        // offering the installer again makes any sense. A WebView's default UA
        // carries `; wv`, which any app could produce, so an explicit tag is the
        // only reliable signal. Appending keeps the real UA, so DSH still sees a
        // normal Android WebView.
        final String ua = settings.getUserAgentString();
        if (ua == null || !ua.contains(APP_UA_TAG)) {
            final String base = ua == null ? "" : ua;
            settings.setUserAgentString(base + " " + APP_UA_TAG);
        }

        // The file chooser only exists if the app supplies onShowFileChooser, and
        // the progress bar needs the same client — so ONE client serves both.
        // Assigning a second one would replace this and silently disable uploads.
        final ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                bar.setProgress(progress);
                bar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return startFilePicker(callback, params);
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // Synchronous, and before any script runs: every new document starts
                // on the shell's loading screen, so the controls go away here rather
                // than waiting for onPageFinished to ask the page about itself.
                if (floatingControls != null) {
                    floatingControls.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPageFinished(WebView view, String loaded) {
                super.onPageFinished(view, loaded);
                prefs.edit().putString(KEY_LAST_URL, loaded).apply();
                // A cookie the gateway just issued has to survive both a lazy jar
                // flush and the next network change, so it is captured here.
                rememberDeviceCookie(loaded);
                flushCookies();
                // The document exists only now; both the theme attribute and the
                // sidebar handle have to be installed after a load, and again
                // after every navigation.
                applyPageTheme();
                // The floating buttons belong to the app UI only. The gateway's own
                // pages — pairing, "device in use" — have no composer to upload into,
                // so the controls hide there instead of floating over them.
                applyPageChrome();
                // The shell mounts asynchronously after the document, so the
                // handle is retried briefly rather than installed once. It is only
                // for the DSH app page — the gateway serves its own pages (pairing,
                // device list) that have no sidebar at all.
                installSidebarHandleWhenReady(40);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                // Only a failed document load means the host is gone; a blocked
                // subresource (an ad, a favicon) must not trigger a re-discovery.
                if (request == null || !request.isForMainFrame()) {
                    return;
                }
                // The old address stopped answering — most often because the machine
                // moved to another network. Re-discover instead of retrying it.
                scheduleReconnect();
            }
        });
        // Replay the pairing before the first request, not after a 401.
        restoreDeviceCookie(url);
        web.loadUrl(url);

        container.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        final FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        barParams.gravity = Gravity.TOP;
        container.addView(bar, barParams);

        // Floating controls on the RIGHT edge: text size/theme and upload. Kept in a
        // field so they can be hidden on the gateway's own pages (pairing, "device in
        // use"), where they would float over a page that has nothing to upload.
        final int floatingSize = dp(40);
        floatingControls = buildFloatingControls();
        // Born hidden. Everything that reveals them waits for the app shell, and a
        // view that starts GONE cannot flash during the load — the previous version
        // relied on a callback that ran after the loading screen was already up.
        floatingControls.setVisibility(View.GONE);
        container.addView(floatingControls, floatingEnd(floatingSize));

        // The sidebar toggle is NOT a native view: it lives inside the page so it
        // can sit on the sidebar's right edge and travel with it when the column
        // collapses. `installSidebarHandle` injects and maintains it.
        root.removeAllViews();
        root.addView(container);
    }

    /**
     * Install a sidebar handle inside the page, on the sidebar's right edge.
     *
     * A native overlay cannot follow this control: the sidebar's width is an
     * inline style on a React element with a CSS transition, so the app would
     * have to poll geometry and fight the animation. Injecting the handle as a
     * page element instead lets the browser keep it glued to the column: it is
     * `position: fixed`, its left offset tracks the column width, and it is
     * re-anchored whenever the column's class flips to `..._collapsed`.
     *
     * The handle is a child of `document.body`, never of the React tree, so React
     * re-renders cannot unmount it; an observer keeps it alive anyway.
     */
    private void installSidebarHandle() {
        if (web == null) {
            return;
        }
        web.evaluateJavascript(SIDEBAR_HANDLE_SCRIPT, value -> { });
    }

    /**
     * Install the handle, retrying while the shell is still mounting.
     *
     * Only for the DSH app page. The gateway serves its own HTML — the pairing
     * page and the device page — and those have no sidebar at all, so injecting
     * there left a stranded control floating over the pairing form. The boot
     * payload is the exact test: the SPA index always carries `__DSH_BOOT__`, and
     * the gateway's pages never do.
     *
     * The retries exist because the shell mounts asynchronously after the
     * document; the boot payload, however, is inline in the head and therefore
     * present on the first tick when this IS the app page.
     *
     * @param attemptsLeft how many more tries are allowed.
     */
    private void installSidebarHandleWhenReady(final int attemptsLeft) {
        if (web == null || attemptsLeft <= 0) {
            return;
        }
        web.evaluateJavascript(SCRIPT_IS_APP_READY, value -> {
            if (value != null && value.contains("yes")) {
                // The shell has rendered: this is the point where the floating
                // controls describe something that exists.
                if (floatingControls != null) {
                    floatingControls.setVisibility(View.VISIBLE);
                }
                installSidebarHandle();
                // The DOM may still be mounting; keep re-measuring briefly.
                if (attemptsLeft > 1) {
                    web.postDelayed(() -> installSidebarHandleWhenReady(attemptsLeft - 1), 400);
                }
            } else if (attemptsLeft > 1) {
                // Still on the loading screen; keep waiting for the shell.
                web.postDelayed(() -> installSidebarHandleWhenReady(attemptsLeft - 1), 400);
            }
        });
    }

    /**
     * Whether the loaded document is the DSH app rather than one of the gateway's
     * own pages. `__DSH_BOOT__` is inline in the index head, so it is already
     * defined on the first tick.
     */
    private static final String SCRIPT_IS_DSH_PAGE =
            "(function(){\n"
                    + "  var boot = globalThis.__DSH_BOOT__;\n"
                    + "  return boot && Array.isArray(boot.entries) ? 'yes' : 'no';\n"
                    + "})()";

    /**
     * Show the floating controls only on the app page.
     *
     * They are Android views layered over the WebView, so no amount of CSS can hide
     * them: on the pairing page and on the "device in use" page they have to be
     * taken out of view by the shell itself.
     */
    private void applyPageChrome() {
        if (web == null) {
            return;
        }
        web.evaluateJavascript(SCRIPT_IS_DSH_PAGE, value -> {
            final boolean isAppPage = value != null && value.contains("yes");
            // Hidden by default on every load: the shell starts on its "Loading
            // plugins…" screen, and the controls only reappear once the sidebar
            // mounts (see installSidebarHandleWhenReady).
            if (floatingControls != null) {
                floatingControls.setVisibility(View.GONE);
            }
            if (!isAppPage) {
                sawNonAppPage = true;
                return;
            }
            // The WebView keeps the layout scale of the document it just left. Coming
            // back from the "device in use" page — which uses a device-width viewport —
            // therefore renders this 1024-wide app several times too large. A fresh
            // WebView is what a manual restart does, so do that automatically instead
            // of asking the operator to relaunch the app.
            if (sawNonAppPage && web != null) {
                sawNonAppPage = false;
                final String current = web.getUrl();
                if (current != null) {
                    root.post(() -> {
                        if (!isFinishing() && current.equals(web == null ? null : web.getUrl())) {
                            showWebView(current);
                        }
                    });
                }
            }
        });
    }

    /**
     * Write the WebView cookie jar to disk.
     *
     * `CookieManager` keeps cookies in memory and persists them lazily, so a
     * device that pairs and then closes the app within seconds could come back
     * unpaired. Flushing after each load and when the app leaves the foreground
     * makes the pairing durable.
     */
    private void flushCookies() {
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
            // Flushing is best effort; a failure must never break navigation.
        }
    }

    /**
     * Keep the gateway's device credential across an address change.
     *
     * A cookie is scoped to its HOST, and the machine's address changes with every
     * network. So the phone pairs against `http://10.61.18.139:8791`, later
     * discovers `http://10.113.184.148:8791`, and the browser correctly refuses to
     * send the old cookie to the new host — the gateway then sees an unpaired
     * device and asks for a code again.
     *
     * The credential itself is NOT host-bound: the gateway signs only
     * `deviceId.expiresAt`. So the app stores the value and replays it for
     * whichever address discovery returns.
     */
    private void rememberDeviceCookie(String url) {
        if (!isGatewayUrl(url)) return;
        try {
            final String header = CookieManager.getInstance().getCookie(url);
            if (header == null || header.isEmpty()) return;
            for (String part : header.split(";")) {
                final String pair = part.trim();
                if (!pair.startsWith(DEVICE_COOKIE_PREFIX)) continue;
                final String value = pair.substring(DEVICE_COOKIE_PREFIX.length());
                if (value.isEmpty()) continue;
                // `getCookie` returns no attributes, so the value is stored alone;
                // the server still enforces its own expiry from the signed payload.
                if (!value.equals(prefs.getString(KEY_DEVICE_COOKIE, ""))) {
                    prefs.edit().putString(KEY_DEVICE_COOKIE, value).apply();
                }
                return;
            }
        } catch (Exception ignored) {
            // Best effort: a failure here only means the phone pairs again.
        }
    }

    /**
     * Put the stored device credential back before loading.
     *
     * Re-issued against the CURRENT host, which is what makes a pairing survive a
     * network change.
     */
    private void restoreDeviceCookie(String url) {
        if (url == null || !isGatewayUrl(url)) return;
        final String value = prefs.getString(KEY_DEVICE_COOKIE, "");
        if (value.isEmpty()) return;
        try {
            final CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setCookie(url, DEVICE_COOKIE_PREFIX + value + "; Path=/; Max-Age=" + COOKIE_MAX_AGE_SECONDS);
            cookies.flush();
        } catch (Exception ignored) {
            // Fall through: the phone simply pairs again.
        }
    }

    /**
     * Whether a URL points at a gateway rather than the plain internet.
     *
     * The gateway is the only thing that ever issues the device cookie, and it only
     * ever listens on this port; checking it keeps the stored credential from being
     * offered to any other host the operator types in. The port must match exactly,
     * so `:87910` is not mistaken for `:8791`.
     */
    private static boolean isGatewayUrl(String url) {
        if (url == null || !url.startsWith("http://")) return false;
        final int schemeEnd = "http://".length();
        final int slash = url.indexOf('/', schemeEnd);
        final String authority = slash < 0 ? url.substring(schemeEnd) : url.substring(schemeEnd, slash);
        return authority.endsWith(GATEWAY_PORT);
    }

    /**
     * Finds the sidebar column.
     *
     * The shell's CSS-module class is `<hash>_root` with a per-build hash (today
     * `wtg9ga_root`), so the suffix `_root` is matched rather than the hash. A
     * bare `_root` suffix is not unique — other modules emit it too — so the
     * match also requires the sidebar's own signals: a full-height column that is
     * neither the app root nor a modal, and whose class list carries one of the
     * sidebar-only tokens the same module emits.
     */
    private static final String SIDEBAR_COLUMN_JS =
            "  function isSidebar(n) {\n"
                    + "    if (!n || n.tagName !== 'DIV') return false;\n"
                    + "    var cls = typeof n.className === 'string' ? n.className : '';\n"
                    // Only the column's own `_root` class is on this element: the
                    // module's other tokens (_collapsed, _logoRow, ...) live on its
                    // CHILDREN, so requiring one here matched nothing and the handle
                    // fell back to -11px. The sidebar is instead identified by the
                    // child markers it must contain plus its geometry.
                    + "    if (!/(^|\\s)[A-Za-z0-9_-]+_root(\\s|$)/.test(cls)) return false;\n"
                    + "    var box = n.getBoundingClientRect();\n"
                    // The sidebar is the left column: tall, on the left EDGE, and
                    // narrower than the frame. `left < innerWidth/2` was not enough —
                    // the content column at x=280 on an 800px frame also satisfies it.
                    + "    if (box.height < 200 || box.width < 40) return false;\n"
                    + "    if (box.left > 24 || box.width > window.innerWidth * 0.6) return false;\n"
                    // The sidebar is the `_root` column that holds the module's
                    // panel list / logo row / new-session button as descendants.
                    + "    return /[A-Za-z0-9_-]+_(panelList|logoRow|newSession|footArea)/.test(n.innerHTML.slice(0, 4000));\n"
                    + "  }\n"
                    + "  function column() {\n"
                    + "    var nodes = document.querySelectorAll('div');\n"
                    + "    for (var i = 0; i < nodes.length; i += 1) if (isSidebar(nodes[i])) return nodes[i];\n"
                    + "    return null;\n"
                    + "  }\n";

    /**
     * Whether the app shell has actually MOUNTED, not merely started loading.
     *
     * `__DSH_BOOT__` says the document is the app; it is already set while the
     * "Loading plugins…" screen is up. The sidebar column only exists once the shell
     * has rendered, which is the moment the floating controls become meaningful —
     * showing them over the loading screen is what the operator objected to.
     */
    private static final String SCRIPT_IS_APP_READY =
            "(function(){\n"
                    + SIDEBAR_COLUMN_JS
                    + "  return column() ? 'yes' : 'no';\n"
                    + "})()";

    /**
     * Creates and anchors the handle. Idempotent: re-running after a navigation
     * replaces the old node instead of stacking a second one.
     *
     * The handle is a CHILD of the sidebar column, positioned `absolute` on its
     * right edge. That is what removes the lag: the column animates
     * `transition: width 0.3s`, and a child in its own coordinate space moves with
     * that width every frame with no script involved. An earlier version kept the
     * handle `position: fixed` on `document.body` and wrote `style.left` from a
     * rAF loop — the loop sampled the animating width, but each write landed in
     * the viewport coordinate space, so the handle visibly trailed the edge.
     */
    private static final String SIDEBAR_HANDLE_SCRIPT =
            "(function(){\n"
                    + SIDEBAR_COLUMN_JS
                    // `column()` walks the DOM and serializes candidates' innerHTML, so
                    // it must not run per event. The resolved element is cached and only
                    // re-resolved once it is gone from the document.
                    + "  var resolved = null;\n"
                    // Gap between the handle's right edge and the column's right edge.
                    // Kept fully INSIDE the column: the earlier `right: -11px` straddled
                    // the border, and an overflow ancestor clipped the outer half away.
                    + "  var GAP = 5;\n"
                    + "  function resolve() {\n"
                    + "    if (resolved && resolved.isConnected) return resolved;\n"
                    + "    resolved = column();\n"
                    + "    return resolved;\n"
                    + "  }\n"
                    + "  function place() {\n"
                    + "    var handle = document.getElementById('dsh-phone-gateway-sidebar-handle');\n"
                    + "    if (!handle) return;\n"
                    + "    var col = resolve();\n"
                    + "    var box = col ? col.getBoundingClientRect() : null;\n"
                    + "    var collapsed = col\n"
                    + "      ? /(^|\\s)[A-Za-z0-9_-]+_collapsed(\\s|$)/.test(col.className || '')\n"
                    + "        || box.width < 90\n"
                    + "      : true;\n"
                    + "    if (col) {\n"
                    // Absolute INSIDE the column, fully within it. The browser then
                    // carries it along through `transition: width 0.3s` on its own —
                    // the behaviour that followed correctly — and nothing sticks out
                    // to be clipped.
                    + "      if (getComputedStyle(col).position === 'static') {\n"
                    + "        col.style.position = 'relative';\n"
                    + "        col.setAttribute('data-lan-anchor', '1');\n"
                    + "      }\n"
                    + "      if (handle.parentNode !== col) col.appendChild(handle);\n"
                    + "      handle.style.position = 'absolute';\n"
                    + "      handle.style.top = '50%';\n"
                    + "      handle.style.transform = 'translateY(-50%)';\n"
                    + "      handle.style.left = 'auto';\n"
                    + "      handle.style.right = GAP + 'px';\n"
                    + "    } else {\n"
                    // No column yet: park it visibly at a plausible rail edge.
                    + "      if (handle.parentNode !== document.body) document.body.appendChild(handle);\n"
                    + "      handle.style.position = 'fixed';\n"
                    + "      handle.style.top = '50%';\n"
                    + "      handle.style.transform = 'translateY(-50%)';\n"
                    + "      handle.style.right = 'auto';\n"
                    + "      handle.style.left = (56 - GAP - 30) + 'px';\n"
                    + "    }\n"
                    + "    handle.style.opacity = col ? '1' : '0.6';\n"
                    + "    if (handle.getAttribute('data-collapsed') !== String(collapsed ? 1 : 0)) {\n"
                    + "      handle.textContent = collapsed ? '\\u203A' : '\\u2039';\n"
                    + "      handle.setAttribute('data-collapsed', collapsed ? '1' : '0');\n"
                    + "    }\n"
                    + "  }\n"
                    + "  function build() {\n"
                    + "    var old = document.getElementById('dsh-phone-gateway-sidebar-handle');\n"
                    + "    if (old) old.remove();\n"
                    // Drop a previous anchoring so a re-install never stacks the
                    // column's positioning override.
                    + "    var anchored = document.querySelector('[data-lan-anchor]');\n"
                    + "    if (anchored) {\n"
                    + "      anchored.style.position = '';\n"
                    + "      anchored.removeAttribute('data-lan-anchor');\n"
                    + "    }\n"
                    + "    var handle = document.createElement('button');\n"
                    + "    handle.id = 'dsh-phone-gateway-sidebar-handle';\n"
                    + "    handle.type = 'button';\n"
                    + "    handle.setAttribute('aria-label', '\\u663e\\u793a/\\u9690\\u85cf\\u4fa7\\u8fb9\\u680f');\n"
                    + "    handle.style.cssText = [\n"
                    + "      'position:absolute', 'top:50%', 'transform:translateY(-50%)',\n"
                    // 30x96: large enough for a thumb on a phone.
                    // `z-index` is deliberately LOW: the handle belongs to the
                    // sidebar's own layer, so any dialog, popover or panel the
                    // shell opens must cover it. An earlier value of
                    // 2147483001 was one higher than the gateway panel's
                    // 2147483000 and punched through its backdrop.
                    + "      'width:30px', 'height:96px', 'z-index:10',\n"
                    + "      'border-radius:8px', 'border:1px solid rgba(127,127,127,.45)',\n"
                    + "      'background:rgba(246,247,249,.96)', 'color:#171a21',\n"
                    + "      'font-size:19px', 'line-height:1', 'padding:0', 'cursor:pointer',\n"
                    + "      'box-shadow:0 2px 10px rgba(0,0,0,.22)'\n"
                    + "    ].join(';');\n"
                    + "    handle.addEventListener('click', function (event) {\n"
                    + "      event.stopPropagation();\n"
                    + "      var toggle = document.querySelector('[data-sidebar-toggle]')\n"
                    + "                || document.querySelector('[data-sidebar-opener]');\n"
                    + "      if (toggle) toggle.click();\n"
                    + "      setTimeout(place, 60);\n"
                    + "      setTimeout(place, 360);\n"
                    + "    });\n"
                    // The node has to exist in the document before place() can find it
                    // by id.
                    + "    document.body.appendChild(handle);\n"
                    + "    place();\n"
                    // Watch only CLASS changes, and never childList: the composer
                    // streams tokens into the transcript continuously, and a
                    // subtree childList observer would fire on every token. Class
                    // changes are rare and are exactly what a collapse/expand flips.
                    + "    if (!window.__dshLanSidebarWatch) {\n"
                    + "      var scheduled = false;\n"
                    + "      var schedule = function () {\n"
                    + "        if (scheduled) return;\n"
                    + "        scheduled = true;\n"
                    + "        setTimeout(function () { scheduled = false; place(); }, 80);\n"
                    + "      };\n"
                    + "      window.__dshLanSidebarWatch = new MutationObserver(schedule);\n"
                    + "      window.__dshLanSidebarWatch.observe(document.body, {\n"
                    + "        attributes: true, attributeFilter: ['class'], subtree: true\n"
                    + "      });\n"
                    // An SPA re-render can swap the column out entirely, which takes
                    // the handle with it. A cheap liveness check re-attaches it
                    // without observing every DOM mutation.
                    + "      setInterval(function () {\n"
                    + "        var live = document.getElementById('dsh-phone-gateway-sidebar-handle');\n"
                    + "        if (!live) {\n"
                    // The node is gone (a re-render replaced its parent): rebuild it.
                    // `build()` skips re-registering the observer, so this cannot loop.
                    + "          resolved = null;\n"
                    + "          build();\n"
                    + "        }\n"
                    + "      }, 1500);\n"
                    + "    }\n"
                    + "  }\n"
                    + "  build();\n"
                    + "  return 'ok';\n"
                    + "})()";

    /** Bridge one `onShowFileChooser` to the system picker. */
    private boolean startFilePicker(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
        }
        fileCallback = callback;
        try {
            // Same suppression as the app's own upload button: a focusable
            // WebView raises the IME again the moment the picker returns.
            suppressKeyboardForPicker();

            // ACTION_GET_CONTENT with `*/*` offers the gallery, documents and any
            // file provider at once.
            final Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params != null
                    && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
            startActivityForResult(Intent.createChooser(pick, "选择图片或文件"), REQUEST_FILE_PICKER);
            return true;
        } catch (Exception failure) {
            fileCallback = null;
            restoreKeyboardAfterPicker();
            return false;
        }
    }

    /**
     * Take the keyboard focus away from the page for the duration of the picker.
     *
     * Clearing focus on the Activity is not enough: the composer is a
     * contenteditable inside the WebView, so the IME reattaches the moment the
     * WebView is touched again — and returning from the system picker counts as a
     * touch. Making the WebView non-focusable and explicitly closing the IME is
     * what actually keeps the keyboard down.
     *
     * @return the previous focusability, restored once the picker returns.
     */
    private boolean suppressKeyboardForPicker() {
        final android.view.inputmethod.InputMethodManager imm =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) {
            final View token = getCurrentFocus() != null ? getCurrentFocus() : root;
            imm.hideSoftInputFromWindow(token.getWindowToken(), 0);
        }
        final boolean wasFocusable = web != null && web.isFocusable();
        if (web != null) {
            // Keep the document visible but unable to raise the IME until the
            // files are in: a focusable WebView reopens the keyboard on return.
            web.clearFocus();
            web.setFocusable(false);
            web.setFocusableInTouchMode(false);
        }
        return wasFocusable;
    }

    /** Give the WebView its focus back once the picker has finished. */
    private void restoreKeyboardAfterPicker() {
        if (web == null) {
            return;
        }
        // Restore even when the operator cancelled: a WebView left non-focusable
        // would silently stop accepting taps into the composer.
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_COMPOSER_PICKER) {
            Uri[] picked = collectUris(resultCode, data);
            // Deliver first, restore focus after: the composer's change handler
            // must run while the page cannot steal the IME back.
            deliverFilesToComposer(picked);
            root.postDelayed(this::restoreKeyboardAfterPicker, 300);
            return;
        }
        if (requestCode != REQUEST_FILE_PICKER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (fileCallback == null) {
            restoreKeyboardAfterPicker();
            return;
        }
        fileCallback.onReceiveValue(collectUris(resultCode, data));
        fileCallback = null;
        root.postDelayed(this::restoreKeyboardAfterPicker, 300);
    }

    /** Every URI a picker result carries, single or multiple. */
    private Uri[] collectUris(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return null;
        }
        if (data.getClipData() != null) {
            final int count = data.getClipData().getItemCount();
            final Uri[] uris = new Uri[count];
            for (int index = 0; index < count; index += 1) {
                uris[index] = data.getClipData().getItemAt(index).getUri();
            }
            return uris;
        }
        if (data.getData() != null) {
            return new Uri[] { data.getData() };
        }
        return null;
    }

    // ------------------------------------------------------------------- theme

    /**
     * Apply the operator's color choice to the page.
     *
     * `WebSettings.setForceDark` is deprecated and inert from Android 13: it
     * cannot switch the DSH UI, which paints from its own CSS instead. The UI
     * switches on `body[data-ds-dark-theme]`, so the app sets that attribute
     * directly — the same lever the DSH theme service pulls.
     *
     * `system` is not offered as a separate mode: the DSH theme preference lives
     * in the Host settings document, which a WebView page cannot read, so the
     * phone cannot know what the computer chose. The operator picks, and the
     * choice is remembered.
     */
    private void applyPageTheme() {
        if (web == null) {
            return;
        }
        final String script =
                "(function(){\n"
                        + "  var dark = " + (nightMode() == NIGHT_DARK ? "true" : "false") + ";\n"
                        + "  if (dark) { document.body.setAttribute('data-ds-dark-theme', ''); }\n"
                        + "  else { document.body.removeAttribute('data-ds-dark-theme'); }\n"
                        + "  return dark ? 'dark' : 'light';\n"
                        + "})()";
        web.evaluateJavascript(script, value -> { });
    }

    private int nightMode() {
        return prefs.getInt(KEY_NIGHT, NIGHT_LIGHT);
    }

    private boolean isDarkTheme() {
        return nightMode() == NIGHT_DARK;
    }

    private int shellTextColor() {
        return isDarkTheme() ? Color.rgb(230, 232, 238) : Color.rgb(23, 26, 33);
    }

    private int shellMutedColor() {
        return isDarkTheme() ? Color.rgb(139, 147, 167) : Color.rgb(93, 100, 116);
    }

    // ----------------------------------------------------------------- controls

    /**
     * The floating controls: text size / theme, and upload.
     *
     * The sidebar toggle is deliberately absent — collapsing the work list from
     * the phone proved more nuisance than help, and the shell's own control is
     * still there for anyone who wants it.
     */
    private View buildFloatingControls() {
        final int size = dp(40);
        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);

        final Button settings = floatingButton("⚙", "字号与主题");
        settings.setOnClickListener(clicked -> openSettingsPanel());
        column.addView(settings, new LinearLayout.LayoutParams(size, size));

        final Button upload = floatingButton("＋", "发送图片或文件");
        upload.setOnClickListener(clicked -> openComposerFilePicker());
        final LinearLayout.LayoutParams uploadParams = new LinearLayout.LayoutParams(size, size);
        uploadParams.topMargin = dp(8);
        column.addView(upload, uploadParams);

        return column;
    }

    /**
     * Open the system file picker and hand the result to the composer.
     *
     * The composer's own "+" is NOT a file button: it opens the `/` command menu
     * (`aria-label: input.commands`). The file input the composer does hold is a
     * hidden `<input type="file">` that DSH wires to keyboard and drop gestures
     * only — no visible control ever clicks it. So the app supplies the control:
     * it runs the system picker itself and then feeds the chosen files through
     * the same hidden input the composer already listens to, which keeps every
     * DSH upload path (validation, size limits, progress) intact.
     */
    private void openComposerFilePicker() {
        suppressKeyboardForPicker();
        try {
            final Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            startActivityForResult(Intent.createChooser(pick, "选择图片或文件"), REQUEST_COMPOSER_PICKER);
        } catch (Exception failure) {
            showToast("无法打开文件选择器");
        }
    }

    /**
     * Give the picked files to the composer's hidden input.
     *
     * A `DataTransfer` populated with real `File` objects assigned through the
     * input's `files` property is the only way to hand HTML file inputs data from
     * script, and the composer's own `onChange` then runs unchanged.
     */
    private void deliverFilesToComposer(final Uri[] uris) {
        if (web == null || uris == null || uris.length == 0) {
            return;
        }

        // Files are read natively and handed over as base64: a content:// URI from
        // the system picker is meaningless to fetch() inside the WebView. The page
        // rebuilds real File objects, assigns them to the input's files property
        // and fires change, so the composer's own handler runs untouched.
        final StringBuilder payload = new StringBuilder("[");
        int delivered = 0;
        for (final Uri uri : uris) {
            try {
                final byte[] bytes = readAllBytes(uri);
                if (bytes == null) {
                    continue;
                }
                if (delivered > 0) {
                    payload.append(',');
                }
                final String mime = getContentResolver().getType(uri);
                payload.append("{\"name\":").append(jsonString(queryDisplayName(uri)))
                        .append(",\"type\":").append(jsonString(mime == null ? "application/octet-stream" : mime))
                        .append(",\"b64\":").append(jsonString(
                                android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)))
                        .append('}');
                delivered += 1;
            } catch (Exception failure) {
                // One unreadable file must not abort the whole selection.
            }
        }
        payload.append(']');

        if (delivered == 0) {
            showToast("无法读取所选文件");
            return;
        }

        final String script =
                "(function(items){\n"
                        + "  var input = null;\n"
                        + "  var walk = function (node) {\n"
                        + "    if (!node || input) return;\n"
                        + "    if (node.tagName === 'INPUT' && node.type === 'file') { input = node; return; }\n"
                        + "    for (var i = 0; i < (node.children || []).length && !input; i += 1) walk(node.children[i]);\n"
                        + "  };\n"
                        + "  walk(document.body);\n"
                        + "  if (!input) return 'no-input';\n"
                        + "  var dt = new DataTransfer();\n"
                        + "  for (var i = 0; i < items.length; i += 1) {\n"
                        + "    var raw = atob(items[i].b64);\n"
                        + "    var buf = new Uint8Array(raw.length);\n"
                        + "    for (var j = 0; j < raw.length; j += 1) buf[j] = raw.charCodeAt(j);\n"
                        + "    dt.items.add(new File([buf], items[i].name, { type: items[i].type }));\n"
                        + "  }\n"
                        + "  input.files = dt.files;\n"
                        + "  input.dispatchEvent(new Event('change', { bubbles: true }));\n"
                        + "  return 'ok:' + dt.files.length;\n"
                        + "})(" + payload + ")";

        web.evaluateJavascript(script, value -> {
            if (value != null && value.contains("no-input")) {
                showToast("输入框尚未就绪，请点一下输入框后重试");
            }
        });
    }

    /** The document name a picker URI carries, falling back to its last segment. */
    private String queryDisplayName(Uri uri) {
        String name = null;
        try (android.database.Cursor cursor = getContentResolver().query(
                uri, new String[] { android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                final int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    name = cursor.getString(index);
                }
            }
        } catch (Exception ignored) {
            // Fall through to the path segment.
        }
        if (name == null || name.isEmpty()) {
            name = uri.getLastPathSegment();
        }
        return name == null || name.isEmpty() ? "file" : name;
    }

    /** Read one picked document fully; the composer needs the bytes, not a handle. */
    private byte[] readAllBytes(Uri uri) {
        try (java.io.InputStream stream = getContentResolver().openInputStream(uri)) {
            if (stream == null) {
                return null;
            }
            final java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            final byte[] chunk = new byte[8192];
            for (int read = stream.read(chunk); read != -1; read = stream.read(chunk)) {
                out.write(chunk, 0, read);
            }
            return out.toByteArray();
        } catch (Exception failure) {
            return null;
        }
    }

    /** A JSON string literal, safe to embed in a script. */
    private static String jsonString(String value) {
        final StringBuilder out = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index += 1) {
            final char c = value.charAt(index);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20 || c == '<' || c == '>' || c == '&') {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }

    private void showToast(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show();
    }

    /**
     * One floating action button, always a 40dp square.
     *
     * A plain `Button` ignores its LayoutParams in one direction: inside a
     * vertical LinearLayout it shrink-wraps its text and the theme background
     * draws a narrow pill, so a single glyph produced a sliver instead of a
     * square. Fixing the view's own minimum size and painting a circular
     * background makes every button identical regardless of its glyph.
     */
    private Button floatingButton(String glyph, String description) {
        final int size = dp(40);
        final Button button = new Button(this);
        button.setText(glyph);
        button.setContentDescription(description);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        button.setTextColor(shellTextColor());
        button.setGravity(Gravity.CENTER);
        button.setPadding(0, 0, 0, 0);
        button.setMinWidth(size);
        button.setMinimumWidth(size);
        button.setMaxWidth(size);
        button.setMinHeight(size);
        button.setMinimumHeight(size);
        button.setMaxHeight(size);

        final android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        shape.setColor(isDarkTheme() ? Color.argb(230, 35, 38, 45) : Color.argb(230, 246, 247, 249));
        shape.setStroke(dp(1), isDarkTheme() ? Color.argb(90, 255, 255, 255) : Color.argb(60, 0, 0, 0));
        button.setBackground(shape);

        return button;
    }

    private FrameLayout.LayoutParams floatingEnd(int size) {
        // The column stacks several buttons, so its HEIGHT must wrap its content.
        final FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(size, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, dp(48), dp(10), 0);
        return params;
    }

    /** The always-available settings sheet: text size and color scheme. */
    private void openSettingsPanel() {
        final FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(Color.argb(140, 0, 0, 0));

        final ScrollView scroll = new ScrollView(this);
        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(20), dp(20), dp(20), dp(20));
        column.setBackgroundColor(isDarkTheme() ? Color.rgb(23, 26, 33) : Color.WHITE);
        scroll.addView(column);

        final TextView heading = new TextView(this);
        heading.setText("显示设置");
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        heading.setTextColor(shellTextColor());
        column.addView(heading);

        final TextView zoomLabel = new TextView(this);
        zoomLabel.setText("字号 " + zoom() + "%");
        zoomLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        zoomLabel.setTextColor(shellMutedColor());
        zoomLabel.setPadding(0, dp(16), 0, dp(4));
        column.addView(zoomLabel);

        final SeekBar slider = new SeekBar(this);
        slider.setMax(MAX_TEXT_ZOOM - MIN_TEXT_ZOOM);
        slider.setProgress(zoom() - MIN_TEXT_ZOOM);
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) {
                    return;
                }
                final int value = MIN_TEXT_ZOOM + progress;
                prefs.edit().putInt(KEY_TEXT_ZOOM, value).apply();
                zoomLabel.setText("字号 " + value + "%");
                if (web != null) {
                    web.getSettings().setTextZoom(value);
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
            }
        });
        column.addView(slider);

        final TextView themeLabel = new TextView(this);
        themeLabel.setText("配色");
        themeLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        themeLabel.setTextColor(shellMutedColor());
        themeLabel.setPadding(0, dp(20), 0, dp(8));
        column.addView(themeLabel);

        column.addView(themeRow("浅色（与电脑默认一致）", NIGHT_LIGHT));
        column.addView(themeRow("深色", NIGHT_DARK));
        final TextView themeHint = new TextView(this);
        themeHint.setText("电脑端若在 DSH 设置里选了深色，这里也选深色即可一致。");
        themeHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        themeHint.setTextColor(shellMutedColor());
        themeHint.setPadding(0, dp(6), 0, 0);
        column.addView(themeHint);

        final Button close = new Button(this);
        close.setText("完成");
        close.setOnClickListener(clicked -> root.removeView(overlay));
        final LinearLayout.LayoutParams closeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        closeParams.topMargin = dp(20);
        column.addView(close, closeParams);

        final FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        panelParams.gravity = Gravity.CENTER;
        panelParams.setMargins(dp(20), dp(20), dp(20), dp(20));
        overlay.addView(scroll, panelParams);
        overlay.setOnClickListener(clicked -> root.removeView(overlay));

        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private View themeRow(String label, int mode) {
        final Button button = new Button(this);
        button.setText(nightMode() == mode ? "● " + label : "○ " + label);
        button.setOnClickListener(clicked -> {
            prefs.edit().putInt(KEY_NIGHT, mode).apply();
            if (web != null) {
                applyPageTheme();
            }
            // Rebuild the sheet so the selected mark moves.
            root.removeViewAt(root.getChildCount() - 1);
            openSettingsPanel();
        });
        return button;
    }

    private int zoom() {
        // Clamped on read: a value stored by an older build could sit outside the
        // range the slider offers now, and the page must never be scaled by it.
        return Math.max(MIN_TEXT_ZOOM, Math.min(MAX_TEXT_ZOOM, prefs.getInt(KEY_TEXT_ZOOM, DEFAULT_TEXT_ZOOM)));
    }

    // ------------------------------------------------------------------ helpers

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (root.getChildCount() > 1) {
                // An overlay is open: close it before leaving the page.
                root.removeViewAt(root.getChildCount() - 1);
                return true;
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Only probe while the app is actually in front of the operator.
        startHeartbeat();
    }

    @Override
    protected void onPause() {
        // Leaving the foreground is exactly when a pairing must not be lost, and
        // Android may kill a backgrounded process without calling onDestroy.
        stopHeartbeat();
        flushCookies();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (networkCallback != null) {
            try {
                final ConnectivityManager manager =
                        (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (manager != null) manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // Already gone; nothing to release.
            }
            networkCallback = null;
        }
        flushCookies();
        destroyWebView();
        super.onDestroy();
    }
}
