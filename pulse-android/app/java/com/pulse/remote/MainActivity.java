package com.pulse.remote;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.security.KeyChain;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

/**
 * The whole user interface: one full-screen WebView on the official harness UI.
 *
 * Nothing about the harness is reimplemented here. That is the point — the
 * official client is the feature set, so the phone gets the real one and inherits
 * every future addition for free.
 */
public class MainActivity extends Activity {

    private static final String TAG = "Pulse";
    /** Camera capture: the photo is written to {@link #cameraOutput} by the camera app. */
    private static final int REQUEST_CAPTURE = 1001;
    /** Gallery or document picker. */
    private static final int REQUEST_PICK = 1003;
    private static final int REQUEST_NOTIFICATIONS = 1002;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    /** The page's own chooser intent, kept only as a fallback when nothing matches. */
    private WebChromeClient.FileChooserParams pendingChooser;
    /** Where the camera is writing the picture it is about to take. */
    private Uri cameraOutput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B1220"));

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);

        configureWebView();

        // The always-available escape hatch: the connection notification carries an
        // action that lands here, so the fallback is reachable from the phone's
        // notification shade at any moment rather than only from a file browser.
        if (getIntent() != null && getIntent().getBooleanExtra("installCert", false)) {
            offerCertificateInstall();
        }

        // Check the engine before loading anything. The official client calls
        // `Promise.withResolvers()`, which no WebView older than Chrome 119
        // implements; on an older one the shell throws on its very first line and
        // the user sees a blank screen with no error anywhere. One explicit
        // sentence is worth more than that.
        int chrome = webViewChromeMajor(this);
        Log.i(TAG, "WebView engine: Chrome " + chrome + " (need " + Config.REQUIRED_CHROME_MAJOR + "+)");
        if (chrome > 0 && chrome < Config.REQUIRED_CHROME_MAJOR) {
            showOverlay(
                    "系统 WebView 版本太旧，官方界面跑不起来。\n\n"
                            + "检测到：Chrome " + chrome + "\n"
                            + "需要：Chrome " + Config.REQUIRED_CHROME_MAJOR + " 或更新\n\n"
                            + "怎么办：\n"
                            + "1) 应用商店里更新「Android System WebView」\n"
                            + "   华为叫「华为浏览器」/「Android 系统 WebView」\n"
                            + "   小米/OPPO/vivo 在应用商店搜「WebView」\n"
                            + "2) 或者把系统浏览器更新到最新版\n"
                            + "3) 更新完重开这个 App\n\n"
                            + "老手机上如果更新不了，这台设备就用不了这个界面。");
            askForNotificationPermission();
            PulseService.start(this);
            return;
        }

        web.loadUrl(Config.BASE_URL + "/");

        askForNotificationPermission();

        // The service tolerates being started before pairing: it retries until a
        // session cookie exists, and its own notification says so in the meantime.
        PulseService.start(this);
    }

    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        // The official client keeps its device credential in localStorage, so
        // without this the phone would have to re-pair on every launch.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        // Zoom is OFF, at the user's request ("手机端不要缩放的功能"). It was turned on once,
        // deliberately — an image opened on its own could not be enlarged at all — and that
        // trade is now the other way round: nothing on this surface scales, which also means
        // a fast second tap cannot be read as the first half of a double-tap-to-zoom.
        //
        // The page asks the same thing two ways (`user-scalable=no` plus `touch-action` in the
        // mobile shell), because a WebView can be built with either half missing; this is the
        // native half, and it is what actually holds on the Android build.
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // A phone opens this over a tunnel; caching the shell is what makes a
        // cold start feel instant instead of re-downloading the client.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Name this build to the page. The shell uses the marker to tell the app
        // apart from a browser, and the diagnostics panel prints the version —
        // which is the only way to answer "which APK is on this phone?" from the
        // phone. Nothing did that before, so a build with a fix and a build
        // without one were indistinguishable once installed.
        settings.setUserAgentString(settings.getUserAgentString() + " " + appTag(this));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {

            /**
             * Accept the deployment's own certificate and nothing else.
             *
             * This deliberately does not blanket-accept SSL errors. The decision
             * is made by comparing the presented public key against the pin this
             * build was compiled with, so a man-in-the-middle presenting any
             * other certificate — including a valid public one — is refused.
             */
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                X509Certificate certificate = x509Of(error);
                if (pinMatches(certificate)) {
                    handler.proceed();
                    return;
                }
                handler.cancel();
                Log.w(TAG, "refused a certificate that does not match the pinned key: " + error.getUrl());
                Toast.makeText(MainActivity.this,
                        "证书与 App 内置的不一致，已拒绝连接。", Toast.LENGTH_LONG).show();
                showOverlay("证书不匹配，已拒绝连接。\n\n如果你换过服务器证书，需要重新生成 App。");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                // Checked before the image case: a file the page explicitly asks to
                // forward must open the share sheet, not the gallery.
                if (host != null && host.equals(Config.HOST)
                        && "1".equals(uri.getQueryParameter("share"))) {
                    Downloader.shareExternally(MainActivity.this, uri.toString(), null);
                    return true;
                }
                // An image opened from the conversation arrives as a top-level file
                // response with no Content-Disposition, so the WebView renders an
                // image document — fitted and zoomed however the WebView pleases,
                // and out of reach of any CSS the shell injects. The phone's own
                // viewer does this properly, so the bytes go there instead. Only
                // navigations reach this method, so inline <img> previews inside
                // the client are untouched.
                if (host != null && host.equals(Config.HOST) && Downloader.looksLikeImage(uri.toString())) {
                    Downloader.showExternally(MainActivity.this, uri.toString());
                    return true;
                }
                // Anything that is not this deployment leaves the app: the shell
                // exists to show the harness, not to become a general browser.
                if (host != null && !host.equals(Config.HOST)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    } catch (Exception ignored) {
                        return false;
                    }
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOverlay("连不上电脑。\n\n"
                            + "1) 电脑上的 DSH 和 Pulse 插件在运行吗？\n"
                            + "2) 隧道还在吗？（电脑上跑 scripts/tunnel.ps1 能看到日志）\n\n"
                            + "下拉或重开 App 会重试。");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideOverlay();
                // WebView writes cookies to disk on its own schedule. Pairing sets
                // the session cookie on this response, so without a flush it lives
                // only in memory until then — and an app killed in that window
                // loses it, which looks to the user like "it forgot me" and costs
                // them a re-pair.
                CookieManager.getInstance().flush();
                // A successful page load is exactly when the cookie the
                // notification stream needs has just been set.
                PulseService.wake(MainActivity.this);
            }
        });

        // A WebView does nothing at all with a download unless the app takes it:
        // navigating to an attachment, or clicking a link carrying the download
        // attribute, is silent otherwise. That is the whole reason files produced
        // on the computer could be read on the phone but never saved.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                Downloader.save(MainActivity.this, url, contentDisposition, mimeType));

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // The official client can attach files; a shell without this
                // silently breaks a real feature. Rather than hand the page's own
                // intent to the system, the source is chosen here: camera, gallery
                // or documents are device questions, and the system photo picker
                // is a better answer than a generic file list.
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                pendingChooser = params;
                UploadSheet.show(MainActivity.this, source -> startSource(source), () -> finishChooser(null));
                return true;
            }
        });
    }

    // ---- uploads -------------------------------------------------------------

    /**
     * This build's identity, as the page sees it.
     *
     * Taken from the manifest so there is exactly one place to bump, and so the
     * number the user reads in the app matches the number Android shows in
     * Settings.
     *
     * @param context any context.
     * @return a token like "PulseApp/1.2".
     */
    private static String appTag(Context context) {
        try {
            String name = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName;
            if (name != null && !name.isEmpty()) return "PulseApp/" + name;
        } catch (Exception error) {
            Log.w(TAG, "could not read the package version: " + error);
        }
        return "PulseApp/unknown";
    }

    /**
     * Launch the picker for one source.
     *
     * @param source where the user wants the bytes to come from.
     */
    private void startSource(UploadSheet.Source source) {
        Intent intent;
        int request;
        switch (source) {
            case CAMERA: {
                // A camera app cannot be handed a file:// path, so the picture is
                // written into this app's cache through its own provider.
                cameraOutput = FileBridge.uriFor(this, "capture-" + System.currentTimeMillis() + ".jpg");
                intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutput);
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                request = REQUEST_CAPTURE;
                break;
            }
            case MEDIA: {
                // GET_CONTENT rather than ACTION_PICK_IMAGES, for two reasons that
                // both showed up as "the attach button does nothing": the photo
                // picker intent needs API 33 and the photo-picker module, and the
                // type it was given here was "image/* video/*", which is not a MIME
                // type at all. GET_CONTENT with EXTRA_MIME_TYPES is the supported
                // way to ask for both, resolves on every version, needs no storage
                // permission, and on Android 13+ the system routes it to the photo
                // picker anyway.
                intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*", "video/*" });
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                request = REQUEST_PICK;
                break;
            }
            default: {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                // Required by OPEN_DOCUMENT, and wrong on the other two: a capture
                // or gallery intent carrying CATEGORY_OPENABLE matches no activity
                // on most devices, which sent the user down the fallback path.
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                request = REQUEST_PICK;
                break;
            }
        }

        try {
            startActivityForResult(intent, request);
        } catch (Exception error) {
            Log.w(TAG, "no activity for " + source + ": " + error);
            // Falling back to the page's own intent keeps attachments working on a
            // device that has none of our three sources.
            Intent fallback = pendingChooser == null ? null : pendingChooser.createIntent();
            if (fallback != null) {
                try {
                    startActivityForResult(fallback, REQUEST_PICK);
                    return;
                } catch (Exception ignored) {
                    /* fall through */
                }
            }
            Toast.makeText(this, getString(R.string.pick_unavailable), Toast.LENGTH_SHORT).show();
            finishChooser(null);
        }
    }

    /**
     * Hand selected URIs back to the page.
     *
     * @param uris the selection, or null to report a cancelled chooser.
     */
    private void finishChooser(Uri[] uris) {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
        }
        pendingChooser = null;
    }

    /**
     * Collect the URIs from a picker result, single or multiple.
     *
     * @param data the result intent.
     * @return the URIs, possibly empty.
     */
    private static Uri[] collect(Intent data) {
        if (data == null) return new Uri[0];
        ClipData clip = data.getClipData();
        if (clip != null) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int index = 0; index < clip.getItemCount(); index += 1) {
                uris[index] = clip.getItemAt(index).getUri();
            }
            return uris;
        }
        Uri single = data.getData();
        return single == null ? new Uri[0] : new Uri[] { single };
    }

    /**
     * The major Chrome version of the system WebView.
     *
     * Read from the default user agent rather than from the WebView package, so it
     * works on every API level this app supports (the package API needs 26).
     *
     * @param context any context.
     * @return the major version, or 0 when it cannot be determined.
     */
    private static int webViewChromeMajor(Context context) {
        try {
            String agent = WebSettings.getDefaultUserAgent(context);
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("Chrome/(\\d+)").matcher(agent);
            if (matcher.find()) return Integer.parseInt(matcher.group(1));
        } catch (Exception error) {
            Log.w(TAG, "could not read the WebView version: " + error);
        }
        return 0;
    }

    // ---- certificate pinning -------------------------------------------------

    /**
     * Recover the X.509 certificate behind an SSL error.
     * @param error the error WebView reported.
     * @return the certificate, or null when it cannot be read.
     */
    private static X509Certificate x509Of(SslError error) {
        SslCertificate presented = error.getCertificate();
        if (presented == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return presented.getX509Certificate();
        }
        Bundle state = SslCertificate.saveState(presented);
        byte[] der = state.getByteArray("x509-certificate");
        if (der == null) return null;
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            return (X509Certificate) factory.generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception error2) {
            return null;
        }
    }

    /**
     * Whether a certificate's public key is the one this build expects.
     * @param certificate the presented certificate.
     * @return true when the SPKI hash matches the pin.
     */
    private static boolean pinMatches(X509Certificate certificate) {
        if (certificate == null) return false;
        try {
            byte[] spki = MessageDigest.getInstance("SHA-256").digest(certificate.getPublicKey().getEncoded());
            return Config.CERT_PIN_SHA256.equals(Base64.encodeToString(spki, Base64.NO_WRAP));
        } catch (Exception error) {
            return false;
        }
    }

    /**
     * Hand this deployment's CA to the system installer, prefilled.
     *
     * This is the prepared fallback for the one thing that cannot be verified
     * without a phone: whether the WebView honours the app's bundled trust anchor
     * for the **WebSocket** the official client opens. If it does not, the page
     * renders but never updates, and installing the certificate into the phone's
     * own credential store makes the WebView trust it independently of anything
     * this app configures.
     *
     * The certificate is already inside the APK, so this removes the alternative:
     * downloading a file, finding it, and navigating four levels of Settings.
     */
    private void offerCertificateInstall() {
        try {
            java.io.InputStream source = getResources().openRawResource(R.raw.pulse_ca);
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = source.read(chunk)) > 0) buffer.write(chunk, 0, read);
            source.close();

            Intent intent = KeyChain.createInstallIntent();
            intent.putExtra(KeyChain.EXTRA_CERTIFICATE, buffer.toByteArray());
            intent.putExtra(KeyChain.EXTRA_NAME, "DeepSeek");
            startActivity(intent);
        } catch (Exception error) {
            Log.w(TAG, "could not start the certificate installer: " + error);
            Toast.makeText(this,
                    "无法启动证书安装，请在浏览器打开 https://" + Config.HOST + "/pulse-ca.crt 手动安装",
                    Toast.LENGTH_LONG).show();
        }
    }

    // ---- overlays ------------------------------------------------------------

    private TextView overlay;

    /**
     * Show a full-screen explanation instead of a blank white page.
     * @param message the text to show.
     */
    private void showOverlay(String message) {
        runOnUiThread(() -> {
            // A callback can arrive after the Activity is gone; touching a
            // destroyed WebView's parent would crash on the way out.
            if (web == null || web.getParent() == null) return;
            if (overlay == null) {
                overlay = new TextView(this);
                overlay.setBackgroundColor(Color.parseColor("#0B1220"));
                overlay.setTextColor(Color.parseColor("#E6EAF2"));
                overlay.setTextSize(15f);
                overlay.setPadding(48, 120, 48, 48);
                ((ViewGroup) web.getParent()).addView(overlay, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            overlay.setText(message);
            overlay.setVisibility(View.VISIBLE);
            overlay.bringToFront();
        });
    }

    /** @return nothing. */
    private void hideOverlay() {
        runOnUiThread(() -> {
            if (overlay != null) overlay.setVisibility(View.GONE);
        });
    }

    // ---- lifecycle -----------------------------------------------------------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Coming back from the notification's "装证书" action while the app is
        // already open: same entry point as a cold start.
        if (intent != null && intent.getBooleanExtra("installCert", false)) {
            offerCertificateInstall();
            return;
        }
        String decisionId = intent.getStringExtra("decisionId");
        if (decisionId != null && web != null) {
            web.loadUrl(Config.BASE_URL + "/pulse#decision-" + Uri.encode(decisionId));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Suppresses the notification the user is already reading on screen.
        PulseService.setVisible(true);
    }

    @Override
    protected void onPause() {
        PulseService.setVisible(false);
        super.onPause();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_CAPTURE) {
            // The camera reports OK but carries no data: the picture is already in
            // the file this app handed it through FileBridge.
            if (resultCode == RESULT_OK && cameraOutput != null) finishChooser(new Uri[] { cameraOutput });
            else finishChooser(null);
            cameraOutput = null;
            return;
        }
        if (requestCode == REQUEST_PICK) {
            Uri[] uris = resultCode == RESULT_OK ? collect(data) : new Uri[0];
            finishChooser(uris.length == 0 ? null : uris);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ---- notifications -------------------------------------------------------

    private void askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTIFICATIONS);
    }
}
