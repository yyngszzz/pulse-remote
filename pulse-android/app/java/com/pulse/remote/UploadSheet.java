package com.pulse.remote;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The upload source sheet: 拍照 / 照片·视频 / 手机文件.
 *
 * ## Why this is native rather than part of the page
 *
 * The mobile shell in the page decides *when* to attach — it clicks the official
 * attach control, so uploading itself stays the official implementation. What
 * this sheet decides is *where the bytes come from*, and that question is about
 * the device, not the document: the camera, the gallery and the document picker
 * are Android activities, and a WebView cannot offer them as a single native
 * chooser.
 *
 * Being native also means it looks like the platform rather than like a web page
 * imitating it, and it brings the system photo picker instead of a file list.
 *
 * The sheet is shown for any file chooser the page opens, so the official
 * composer's own attach button gets the same three choices.
 */
final class UploadSheet {

    /** Where the user wants the bytes to come from. */
    enum Source {
        /** The camera, one photo, written straight into the app cache. */
        CAMERA,
        /** The system photo picker: images and video, multiple. */
        MEDIA,
        /** The document picker: anything, multiple. */
        FILES
    }

    /** Receives the chosen source. */
    interface OnPick {
        /**
         * @param source the chosen source.
         */
        void onPick(Source source);
    }

    private UploadSheet() {}

    /**
     * Show the sheet.
     *
     * @param context the hosting activity.
     * @param onPick called with the chosen source.
     * @param onCancel called when the sheet is dismissed without a choice.
     *
     * The cancel path is not decoration. The page is sitting on an unresolved file
     * chooser while this sheet is up, and a chooser that is never answered leaves
     * the attach button looking like it did nothing — so every way out of the
     * sheet has to report back.
     */
    static void show(Context context, OnPick onPick, Runnable onCancel) {
        final Dialog dialog = new Dialog(context);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(context, 12), dp(context, 14), dp(context, 12), dp(context, 12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.parseColor("#1B1E26"));
        float radius = dp(context, 20);
        background.setCornerRadii(new float[] { radius, radius, radius, radius, 0, 0, 0, 0 });
        root.setBackground(background);

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setBaselineAligned(false);

        row.addView(cell(context, dialog, onPick, Source.CAMERA, R.drawable.ic_camera,
                context.getString(R.string.pick_camera)));
        row.addView(cell(context, dialog, onPick, Source.MEDIA, R.drawable.ic_media,
                context.getString(R.string.pick_media)));
        row.addView(cell(context, dialog, onPick, Source.FILES, R.drawable.ic_folder,
                context.getString(R.string.pick_files)));
        root.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView cancel = new TextView(context);
        cancel.setText(context.getString(R.string.pick_cancel));
        cancel.setTextColor(Color.parseColor("#8C93A0"));
        cancel.setTextSize(14f);
        cancel.setGravity(Gravity.CENTER);
        cancel.setPadding(0, dp(context, 12), 0, dp(context, 6));
        cancel.setOnClickListener(v -> {
            dialog.dismiss();
            onCancel.run();
        });
        root.addView(cancel);

        // Back button and tap-outside are cancellations too, and dismiss() from a
        // cell does not reach this listener, so the two paths cannot double-fire.
        dialog.setOnCancelListener(dismissed -> onCancel.run());
        dialog.setCanceledOnTouchOutside(true);

        dialog.setContentView(root);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.dimAmount = 0.5f;
            window.setAttributes(attributes);
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM);
        }
        dialog.show();
    }

    /**
     * One tappable cell: a large icon over a label, sized for a thumb.
     *
     * @param context the hosting activity.
     * @param dialog the sheet, dismissed on tap.
     * @param onPick the callback.
     * @param source the source this cell selects.
     * @param icon the drawable to show.
     * @param label the caption.
     * @return the cell view.
     */
    private static View cell(Context context, final Dialog dialog, final OnPick onPick,
                             final Source source, int icon, String label) {
        LinearLayout cell = new LinearLayout(context);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setPadding(0, dp(context, 14), 0, dp(context, 14));
        cell.setClickable(true);
        cell.setFocusable(true);

        GradientDrawable tile = new GradientDrawable();
        tile.setColor(Color.parseColor("#262A34"));
        tile.setCornerRadius(dp(context, 14));
        cell.setBackground(tile);

        ImageView image = new ImageView(context);
        image.setImageResource(icon);
        int iconSize = dp(context, 26);
        cell.addView(image, new LinearLayout.LayoutParams(iconSize, iconSize));

        TextView caption = new TextView(context);
        caption.setText(label);
        caption.setTextColor(Color.parseColor("#E6EAF2"));
        caption.setTextSize(12.5f);
        caption.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        captionParams.topMargin = dp(context, 9);
        cell.addView(caption, captionParams);

        cell.setOnClickListener(v -> {
            dialog.dismiss();
            onPick.onPick(source);
        });

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        int gap = dp(context, 5);
        params.setMargins(gap, 0, gap, 0);
        cell.setLayoutParams(params);
        return cell;
    }

    /**
     * Convert dp to pixels.
     * @param context any context.
     * @param value the dp value.
     * @return the pixel value.
     */
    private static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
