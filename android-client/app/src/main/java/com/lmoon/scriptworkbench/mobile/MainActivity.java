package com.lmoon.scriptworkbench.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int ACCENT = 0xFF2563EB;
    private static final int PAGE_BG = 0xFFF6F8FC;
    private static final int CARD_BG = 0xFFFFFFFF;
    private static final int TEXT_PRIMARY = 0xFF1F2937;
    private static final int TEXT_SECONDARY = 0xFF6B7280;
    private static final int OK_GREEN = 0xFF16A34A;
    private static final int ERR_RED = 0xFFDC2626;
    private static final int TAB_IDLE_BG = 0xFFEFF3FB;
    private static final long POLL_MS = 3000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private EditText baseUrlInput;
    private EditText pairingCodeInput;
    private TextView statusText;
    private LinearLayout tasksBox;
    private LinearLayout runsBox;
    private LinearLayout filesBox;
    private LinearLayout sharesBox;
    private TextView outputText;
    private ScrollView logScroll;
    private final View[] pages = new View[4];
    private final Button[] tabs = new Button[4];
    private int currentPage = 0;
    private String token = "";

    // live-update + selection state
    private boolean resumed = false;
    private boolean tickScheduled = false;
    private boolean anyRunning = false;
    private boolean selectedRunLive = false;
    private String selectedRunId = "";
    private final Runnable tickRunnable = this::tick;

    // file view state
    private boolean showAllFiles = false;
    private JSONArray lastFiles = new JSONArray();
    private String lastFilesStartedAt = "";
    private String lastFilesLog = "";

    // shared-folder browsing state
    private String currentShareId = "";
    private String currentSharePath = "";
    private String currentShareLabel = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
        SharedPreferences prefs = getSharedPreferences("script_workbench_mobile", MODE_PRIVATE);
        token = prefs.getString("token", "");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(PAGE_BG);
        root.setPadding(dp(16), dp(20), dp(16), 0);
        root.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(title("Script Workbench"));
        statusText = text("准备连接");
        statusText.setTextColor(TEXT_SECONDARY);
        root.addView(statusText);

        root.addView(buildTabBar());

        FrameLayout content = new FrameLayout(this);
        content.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        pages[0] = buildTasksPage(prefs);
        pages[1] = buildRunsPage();
        pages[2] = buildFilesPage();
        pages[3] = buildSharesPage();
        for (View page : pages) content.addView(page);
        root.addView(content);

        setContentView(root);
        showPage(0);

        // auto-open keyboard on the pairing code field
        pairingCodeInput.requestFocus();
        main.postDelayed(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(pairingCodeInput, InputMethodManager.SHOW_IMPLICIT);
        }, 250);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (!token.isEmpty()) {
            refreshAll();
            startTicking();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        tickScheduled = false;
        main.removeCallbacks(tickRunnable);
    }

    // ---- page scaffolding ----

    private LinearLayout buildTabBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        lp.bottomMargin = dp(6);
        bar.setLayoutParams(lp);
        String[] labels = {"任务", "运行 · 日志", "文件", "共享"};
        for (int i = 0; i < 4; i++) {
            Button b = new Button(this);
            b.setText(labels[i]);
            b.setAllCaps(false);
            final int idx = i;
            b.setOnClickListener(v -> showPage(idx));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            blp.leftMargin = dp(3);
            blp.rightMargin = dp(3);
            b.setLayoutParams(blp);
            tabs[i] = b;
            bar.addView(b);
        }
        return bar;
    }

    private void showPage(int index) {
        currentPage = index;
        for (int i = 0; i < 4; i++) {
            pages[i].setVisibility(i == index ? View.VISIBLE : View.GONE);
            styleTab(tabs[i], i == index);
        }
        if (index == 3 && !token.isEmpty()) {
            loadShares();
        }
    }

    private void styleTab(Button b, boolean active) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(active ? ACCENT : TAB_IDLE_BG);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        b.setTextColor(active ? Color.WHITE : TEXT_SECONDARY);
        b.setTypeface(Typeface.DEFAULT, active ? Typeface.BOLD : Typeface.NORMAL);
    }

    private ScrollView page() {
        ScrollView s = new ScrollView(this);
        s.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        s.setFillViewport(true);
        return s;
    }

    private ScrollView buildTasksPage(SharedPreferences prefs) {
        ScrollView s = page();
        LinearLayout col = column();
        col.setPadding(0, dp(4), 0, dp(24));

        LinearLayout connCard = card();
        connCard.addView(fieldLabel("电脑 API 地址"));
        baseUrlInput = input(prefs.getString("base_url", "http://127.0.0.1:17631"), "电脑 API 地址");
        connCard.addView(baseUrlInput);
        connCard.addView(fieldLabel("配对码"));
        pairingCodeInput = input("", "配对码");
        connCard.addView(pairingCodeInput);
        LinearLayout actions = row();
        Button pairButton = primaryButton("配对");
        pairButton.setOnClickListener(v -> pair());
        Button refreshButton = plainButton("刷新");
        refreshButton.setOnClickListener(v -> refreshAll());
        actions.addView(wrap(pairButton, 1f));
        actions.addView(wrap(refreshButton, 1f));
        connCard.addView(actions);
        col.addView(connCard);

        col.addView(sectionTitle("任务"));
        tasksBox = column();
        col.addView(tasksBox);

        s.addView(col);
        return s;
    }

    private ScrollView buildRunsPage() {
        ScrollView s = page();
        LinearLayout col = column();
        col.setPadding(0, dp(4), 0, dp(24));

        col.addView(sectionTitle("运行记录"));
        runsBox = column();
        col.addView(runsBox);

        col.addView(sectionTitle("实时日志"));
        LinearLayout logCard = card();
        logScroll = new ScrollView(this);
        logScroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(320)));
        outputText = text("点任务的「日志」查看，运行中会自动刷新");
        outputText.setTypeface(Typeface.MONOSPACE);
        outputText.setTextSize(12);
        outputText.setTextColor(TEXT_SECONDARY);
        outputText.setTextIsSelectable(true);
        logScroll.addView(outputText);
        logCard.addView(logScroll);
        col.addView(logCard);

        s.addView(col);
        return s;
    }

    private ScrollView buildFilesPage() {
        ScrollView s = page();
        LinearLayout col = column();
        col.setPadding(0, dp(4), 0, dp(24));
        col.addView(sectionTitle("输出文件"));
        filesBox = column();
        filesBox.addView(hint("在「运行 · 日志」页点某条记录的「文件」查看"));
        col.addView(filesBox);
        s.addView(col);
        return s;
    }

    private ScrollView buildSharesPage() {
        ScrollView s = page();
        LinearLayout col = column();
        col.setPadding(0, dp(4), 0, dp(24));
        col.addView(sectionTitle("共享文件夹"));
        sharesBox = column();
        sharesBox.addView(hint("配对后进入本页会自动加载电脑上配置的共享文件夹"));
        col.addView(sharesBox);
        s.addView(col);
        return s;
    }

    // ---- shared-folder browsing ----

    private void loadShares() {
        runNetwork(() -> {
            JSONArray shares = new JSONArray(request("GET", "/api/shares", null, true));
            ui(() -> {
                currentShareId = "";
                currentSharePath = "";
                currentShareLabel = "";
                renderShareRoots(shares);
                setStatus("共享文件夹：" + shares.length() + " 个", OK_GREEN);
            });
        });
    }

    private void renderShareRoots(JSONArray shares) {
        sharesBox.removeAllViews();
        if (shares.length() == 0) {
            sharesBox.addView(hint("桌面端未配置共享文件夹"));
            return;
        }
        sharesBox.addView(subtitle("选择一个共享文件夹开始浏览"));
        for (int i = 0; i < shares.length(); i++) {
            JSONObject share = shares.optJSONObject(i);
            if (share == null) continue;
            final String shareId = share.optString("shareId", "");
            final String label = share.optString("label", shareId);
            if (shareId.isEmpty()) continue;
            LinearLayout item = card();
            item.addView(cardTitle(label));
            Button open = plainButton("打开");
            open.setOnClickListener(v -> {
                currentShareLabel = label;
                loadShareEntries(shareId, "");
            });
            item.addView(open);
            sharesBox.addView(item);
        }
    }

    private void loadShareEntries(String shareId, String relPath) {
        runNetwork(() -> {
            String encoded = URLEncoder.encode(relPath == null ? "" : relPath, "UTF-8");
            JSONObject resp = new JSONObject(request(
                    "GET", "/api/shares/" + shareId + "/entries?path=" + encoded, null, true));
            ui(() -> {
                currentShareId = shareId;
                currentSharePath = resp.optString("path", "");
                currentShareLabel = resp.optString("label", currentShareLabel);
                renderShareEntries(resp);
                setStatus(currentShareLabel + " / " + currentSharePath, OK_GREEN);
            });
        });
    }

    private void renderShareEntries(JSONObject resp) {
        sharesBox.removeAllViews();
        final String shareId = resp.optString("shareId", currentShareId);
        String path = resp.optString("path", "");
        boolean hasParent = !resp.isNull("parent");
        final String parent = hasParent ? resp.optString("parent", "") : null;

        Button backToRoots = plainButton("⬅ 返回共享列表");
        backToRoots.setOnClickListener(v -> loadShares());
        sharesBox.addView(backToRoots);

        sharesBox.addView(subtitle(currentShareLabel
                + (path.isEmpty() ? " / (根目录)" : " / " + path)));

        if (hasParent) {
            Button up = plainButton("⬆ 上级目录");
            up.setOnClickListener(v -> loadShareEntries(shareId, parent));
            sharesBox.addView(up);
        }

        JSONArray entries = resp.optJSONArray("entries");
        if (entries == null || entries.length() == 0) {
            sharesBox.addView(hint("此文件夹为空"));
            return;
        }
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry == null) continue;
            final boolean isDir = entry.optBoolean("isDir", false);
            final String name = entry.optString("name", "");
            final String relPath = entry.optString("relPath", "");
            final String contentType = entry.optString("contentType", "application/octet-stream");
            LinearLayout item = card();
            item.addView(cardTitle((isDir ? "📁 " : "📄 ") + name));
            if (isDir) {
                Button open = plainButton("进入");
                open.setOnClickListener(v -> loadShareEntries(shareId, relPath));
                item.addView(open);
            } else {
                item.addView(subtitle(humanSize(entry.optLong("bytes", 0)) + " · " + contentType));
                Button download = plainButton("传输到手机");
                download.setOnClickListener(v -> executor.execute(
                        () -> transferSharePath(shareId, relPath, name, contentType)));
                item.addView(download);
            }
            sharesBox.addView(item);
        }
    }

    private boolean transferSharePath(String shareId, String relPath, String rawName, String contentType) {
        String name = sanitize(rawName);
        ui(() -> setStatus("传输中：" + name, ACCENT));
        HttpURLConnection connection = null;
        try {
            String encoded = URLEncoder.encode(relPath, "UTF-8");
            URL url = new URL(normalizedBaseUrl() + "/api/shares/" + shareId + "/download?path=" + encoded);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            if (!token.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = connection.getResponseCode();
            if (code >= 400) {
                ui(() -> setStatus("传输失败 HTTP " + code + "：" + name, ERR_RED));
                return false;
            }
            long total = connection.getContentLengthLong();
            String subDir = shareSubDir(relPath);
            Uri saved = saveStream(connection.getInputStream(), name, contentType, total, subDir);
            if (saved == null) {
                ui(() -> setStatus("保存失败：" + name, ERR_RED));
                return false;
            }
            final Uri openUri = saved;
            ui(() -> {
                setStatus("已保存到手机：" + subDir + "/" + name, OK_GREEN);
                openFile(openUri, contentType);
            });
            return true;
        } catch (Exception e) {
            ui(() -> setStatus("传输失败：" + e.getMessage(), ERR_RED));
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // Mirror source structure: <共享名>/<相对父目录>
    private String shareSubDir(String relPath) {
        String parent = "";
        String normalized = relPath == null ? "" : relPath.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        if (slash > 0) {
            parent = normalized.substring(0, slash);
        }
        String base = sanitizePathSegments(currentShareLabel);
        if (!parent.isEmpty()) {
            base = base + "/" + sanitizePathSegments(parent);
        }
        return base;
    }

    private String sanitizePathSegments(String value) {
        if (value == null || value.isEmpty()) return "";
        String[] parts = value.replace('\\', '/').split("/");
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) continue;
            String clean = part.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (clean.isEmpty()) continue;
            if (out.length() > 0) out.append('/');
            out.append(clean);
        }
        return out.toString();
    }


    // ---- networking flows ----

    private void pair() {
        runNetwork(() -> {
            JSONObject body = new JSONObject();
            body.put("pairingCode", pairingCodeInput.getText().toString().trim());
            JSONObject result = new JSONObject(request("POST", "/api/pair", body.toString(), false));
            token = result.getString("token");
            getSharedPreferences("script_workbench_mobile", MODE_PRIVATE)
                    .edit()
                    .putString("base_url", normalizedBaseUrl())
                    .putString("token", token)
                    .apply();
            ui(() -> {
                setStatus("配对成功", OK_GREEN);
                refreshAll();
                startTicking();
            });
        });
    }

    private void refreshAll() {
        runNetwork(() -> {
            JSONArray tasks = new JSONArray(request("GET", "/api/tasks", null, true));
            JSONArray runs = new JSONArray(request("GET", "/api/runs", null, true));
            ui(() -> {
                renderTasks(tasks);
                renderRuns(runs);
                setStatus("已刷新 · " + tasks.length() + " 个任务", OK_GREEN);
                if (resumed && (anyRunning || selectedRunLive)) startTicking();
            });
        });
    }

    // ---- live auto-update (foreground) ----

    private void startTicking() {
        if (!tickScheduled) {
            tickScheduled = true;
            main.postDelayed(tickRunnable, POLL_MS);
        }
    }

    private void tick() {
        tickScheduled = false;
        if (!resumed || token.isEmpty()) return;
        executor.execute(() -> {
            try {
                JSONArray runs = new JSONArray(request("GET", "/api/runs", null, true));
                String logRunId = selectedRunId;
                final String logText = (selectedRunLive && logRunId != null && !logRunId.isEmpty())
                        ? fetchOutput(logRunId) : null;
                ui(() -> {
                    renderRuns(runs);
                    if (logText != null) setLog(logText);
                    if (resumed && (anyRunning || selectedRunLive)) startTicking();
                });
            } catch (Exception ignored) {
                ui(() -> {
                    if (resumed && (anyRunning || selectedRunLive)) startTicking();
                });
            }
        });
    }

    // ---- tasks + parameter input ----

    private void renderTasks(JSONArray tasks) {
        tasksBox.removeAllViews();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) continue;
            final JSONObject taskRef = task;
            LinearLayout item = card();
            item.addView(cardTitle(task.optString("name", "未命名任务")));
            int paramCount = editableParams(task).size();
            String sub = kindLabel(task.optString("kind", ""))
                    + (paramCount > 0 ? " · " + paramCount + " 个参数" : "");
            item.addView(subtitle(sub));
            Button run = primaryButton(paramCount > 0 ? "配置并运行" : "运行");
            run.setOnClickListener(v -> onRunTapped(taskRef));
            item.addView(run);
            tasksBox.addView(item);
        }
        if (tasks.length() == 0) tasksBox.addView(hint("暂无任务"));
    }

    private String kindLabel(String kind) {
        switch (kind) {
            case "python_task": return "Python 任务";
            case "command_task": return "命令任务";
            default: return kind;
        }
    }

    private List<JSONObject> editableParams(JSONObject task) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray params = task.optJSONArray("runtimeParameters");
        if (params == null) return out;
        for (int i = 0; i < params.length(); i++) {
            JSONObject p = params.optJSONObject(i);
            if (p == null) continue;
            if (!p.optBoolean("enabled", true)) continue;
            boolean hasDerived = !p.isNull("derivedTemplate")
                    && !p.optString("derivedTemplate", "").isEmpty();
            boolean allowOverride = p.optBoolean("allowOverride", true);
            if (hasDerived && !allowOverride) continue;
            if (p.optBoolean("locked", false) && !allowOverride) continue;
            out.add(p);
        }
        return out;
    }

    private void onRunTapped(JSONObject task) {
        String taskId = task.optString("id", "");
        if (taskId.isEmpty()) return;
        List<JSONObject> params = editableParams(task);
        if (params.isEmpty()) {
            runTask(taskId, new JSONObject());
        } else {
            showRunDialog(task, params);
        }
    }

    private void showRunDialog(JSONObject task, List<JSONObject> params) {
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(4), dp(20), dp(4));
        scroll.addView(box);

        final List<ParamField> fields = new ArrayList<>();
        for (JSONObject p : params) {
            fields.add(buildField(box, p));
        }

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("运行 " + task.optString("name", "任务"))
                .setView(scroll)
                .setPositiveButton("运行", null)
                .setNegativeButton("取消", null)
                .create();
        dialog.setOnShowListener(d -> {
            Button ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            ok.setOnClickListener(v -> {
                JSONObject values = new JSONObject();
                for (ParamField f : fields) {
                    String value = f.value();
                    if (f.required && value.trim().isEmpty()) {
                        f.markError();
                        toast("请填写：" + f.label);
                        return;
                    }
                    try {
                        values.put(f.name, value);
                    } catch (Exception ignored) {
                    }
                }
                dialog.dismiss();
                runTask(task.optString("id", ""), values);
            });
        });
        dialog.show();
    }

    private static class ParamField {
        final String name;
        final String label;
        final boolean required;
        final EditText edit;
        final CheckBox check;
        final Spinner spinner;

        ParamField(String name, String label, boolean required,
                   EditText edit, CheckBox check, Spinner spinner) {
            this.name = name;
            this.label = label;
            this.required = required;
            this.edit = edit;
            this.check = check;
            this.spinner = spinner;
        }

        String value() {
            if (check != null) return check.isChecked() ? "true" : "false";
            if (spinner != null) {
                Object s = spinner.getSelectedItem();
                return s == null ? "" : s.toString();
            }
            return edit == null ? "" : edit.getText().toString();
        }

        void markError() {
            if (edit != null) edit.setError("必填");
        }
    }

    private ParamField buildField(LinearLayout box, JSONObject p) {
        String name = p.optString("name", "");
        String label = p.optString("label", name);
        String type = p.optString("type", "text");
        boolean required = p.optBoolean("required", false);
        String def = p.optString("defaultValue", "");
        String desc = p.optString("description", "");

        TextView lbl = new TextView(this);
        lbl.setText(required ? label + " *" : label);
        lbl.setTextColor(TEXT_PRIMARY);
        lbl.setTypeface(Typeface.DEFAULT_BOLD);
        lbl.setPadding(0, dp(12), 0, dp(2));
        box.addView(lbl);
        if (!desc.isEmpty()) {
            TextView d = new TextView(this);
            d.setText(desc);
            d.setTextSize(12);
            d.setTextColor(TEXT_SECONDARY);
            d.setPadding(0, 0, 0, dp(4));
            box.addView(d);
        }

        if ("boolean".equals(type)) {
            CheckBox cb = new CheckBox(this);
            cb.setText("启用");
            cb.setChecked("true".equalsIgnoreCase(def));
            box.addView(cb);
            return new ParamField(name, label, required, null, cb, null);
        }
        if ("choice".equals(type)) {
            JSONArray opts = p.optJSONArray("options");
            List<String> items = new ArrayList<>();
            if (opts != null) {
                for (int i = 0; i < opts.length(); i++) items.add(opts.optString(i, ""));
            }
            Spinner sp = new Spinner(this);
            sp.setAdapter(new ArrayAdapter<>(this,
                    android.R.layout.simple_spinner_dropdown_item, items));
            int idx = items.indexOf(def);
            if (idx >= 0) sp.setSelection(idx);
            box.addView(sp);
            return new ParamField(name, label, required, null, null, sp);
        }
        EditText et = new EditText(this);
        et.setText(def);
        et.setHint(label);
        et.setSingleLine(true);
        et.setTextColor(TEXT_PRIMARY);
        if ("number".equals(type)) {
            et.setInputType(InputType.TYPE_CLASS_NUMBER
                    | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED);
        } else if ("secret".equals(type)) {
            et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        }
        box.addView(et);
        return new ParamField(name, label, required, et, null, null);
    }

    private void runTask(String taskId, JSONObject runtimeValues) {
        if (taskId.isEmpty()) return;
        runNetwork(() -> {
            JSONObject body = new JSONObject();
            body.put("runtimeValues", runtimeValues);
            JSONObject run = new JSONObject(
                    request("POST", "/api/tasks/" + taskId + "/run", body.toString(), true));
            ui(() -> {
                setStatus("已启动：" + run.optString("taskName", taskId), ACCENT);
                showPage(1);
                refreshAll();
                startTicking();
            });
        });
    }

    // ---- runs + live logs ----

    private void renderRuns(JSONArray runs) {
        runsBox.removeAllViews();
        anyRunning = false;
        boolean selStillLive = false;
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.optJSONObject(i);
            if (run == null) continue;
            final String runId = run.optString("id", "");
            final String startedAt = run.optString("startedAt", "");
            String status = run.optString("status", "");
            boolean running = "running".equals(status);
            if (running) anyRunning = true;
            if (running && runId.equals(selectedRunId)) selStillLive = true;

            LinearLayout item = card();
            if (runId.equals(selectedRunId)) {
                GradientDrawable bg = (GradientDrawable) item.getBackground();
                bg.setStroke(dp(2), ACCENT);
            }
            item.addView(cardTitle(run.optString("taskName", "运行")));
            TextView st = subtitle(statusLabel(status)
                    + (startedAt.isEmpty() ? "" : " · " + shortTime(startedAt)));
            st.setTextColor(statusColor(status));
            item.addView(st);
            LinearLayout actions = row();
            Button logs = plainButton("日志");
            logs.setOnClickListener(v -> onLogsTapped(runId, status));
            Button files = plainButton("文件");
            files.setOnClickListener(v -> onFilesTapped(runId, startedAt));
            actions.addView(wrap(logs, 1f));
            actions.addView(wrap(files, 1f));
            if (running) {
                Button stop = plainButton("停止");
                stop.setOnClickListener(v -> stopRun(runId));
                actions.addView(wrap(stop, 1f));
            }
            item.addView(actions);
            runsBox.addView(item);
        }
        if (runs.length() == 0) runsBox.addView(hint("暂无运行记录"));
        selectedRunLive = selStillLive;
    }

    private void onLogsTapped(String runId, String status) {
        selectedRunId = runId;
        selectedRunLive = "running".equals(status);
        loadOutput(runId);
        if (selectedRunLive) startTicking();
    }

    private void onFilesTapped(String runId, String startedAt) {
        showPage(2);
        loadFiles(runId, startedAt);
    }

    private String statusLabel(String s) {
        switch (s) {
            case "running": return "运行中";
            case "finished": return "已完成";
            case "failed": return "失败";
            case "stopped": return "已停止";
            default: return s;
        }
    }

    private int statusColor(String s) {
        switch (s) {
            case "running": return ACCENT;
            case "finished": return OK_GREEN;
            case "failed": return ERR_RED;
            default: return TEXT_SECONDARY;
        }
    }

    private void stopRun(String runId) {
        runNetwork(() -> {
            request("POST", "/api/runs/" + runId + "/stop", "", true);
            ui(() -> {
                setStatus("已发送停止请求", ACCENT);
                refreshAll();
            });
        });
    }

    private String fetchOutput(String runId) throws Exception {
        JSONObject output = new JSONObject(
                request("GET", "/api/runs/" + runId + "/output", null, true));
        String stdout = output.optString("stdout", "");
        String stderr = output.optString("stderr", "");
        return (stdout + "\n" + stderr).trim();
    }

    private void loadOutput(String runId) {
        runNetwork(() -> {
            String merged = fetchOutput(runId);
            ui(() -> {
                setLog(merged);
                setStatus(selectedRunLive ? "运行中 · 日志实时刷新" : "日志已更新", OK_GREEN);
            });
        });
    }

    private void setLog(String merged) {
        outputText.setText(merged.isEmpty() ? "暂无日志" : tail(merged, 8000));
        if (logScroll != null) {
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        }
    }

    // ---- output files (scoped to the run + in-app transfer) ----

    private void loadFiles(String runId, String startedAt) {
        runNetwork(() -> {
            JSONArray files = new JSONArray(
                    request("GET", "/api/runs/" + runId + "/files", null, true));
            String log;
            try {
                log = fetchOutput(runId);
            } catch (Exception e) {
                log = "";
            }
            final String logFinal = log;
            ui(() -> {
                showAllFiles = false;
                lastFiles = files;
                lastFilesStartedAt = startedAt == null ? "" : startedAt;
                lastFilesLog = logFinal;
                renderFiles();
            });
        });
    }

    private JSONArray displayedFiles() {
        if (showAllFiles) return lastFiles;
        JSONArray out = new JSONArray();
        for (int i = 0; i < lastFiles.length(); i++) {
            JSONObject f = lastFiles.optJSONObject(i);
            if (f != null && (producedByRun(f, lastFilesStartedAt) || referencedInLog(f))) {
                out.put(f);
            }
        }
        return out;
    }

    private boolean producedByRun(JSONObject file, String startedAt) {
        if (startedAt == null || startedAt.isEmpty()) return true;
        Long fileMs = epochMs(file.optString("modifiedAt", ""));
        Long startMs = epochMs(startedAt);
        if (fileMs == null || startMs == null) return true; // fail open
        return fileMs >= startMs - 30000L;
    }

    // Files may be produced by a *previous* run and merely reused this run
    // (e.g. "[跳过] 输出已存在: ...pdf"). Those have an old mtime, so also match
    // any file whose name/path the run log references.
    private boolean referencedInLog(JSONObject file) {
        if (lastFilesLog == null || lastFilesLog.isEmpty()) return false;
        String localPath = file.optString("localPath", "");
        if (!localPath.isEmpty() && lastFilesLog.contains(localPath)) return true;
        String name = file.optString("name", "");
        if (name.isEmpty()) return false;
        if (lastFilesLog.contains(name)) return true;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        if (base.length() >= 8 && lastFilesLog.contains(base)) return true;
        // logs sometimes shorten the leading title with "…"; the trailing id
        // (date + hash + extension) stays intact, so match a unique tail.
        if (name.length() >= 24 && lastFilesLog.contains(name.substring(name.length() - 24))) {
            return true;
        }
        return false;
    }

    private void renderFiles() {
        filesBox.removeAllViews();
        JSONArray shown = displayedFiles();
        int total = lastFiles.length();
        int hidden = total - shown.length();

        TextView summary = subtitle(showAllFiles
                ? ("全部文件：" + total + " 个（含历史）")
                : ("本次运行输出：" + shown.length() + " 个"
                    + (hidden > 0 ? " · 已隐藏 " + hidden + " 个历史文件" : "")));
        filesBox.addView(summary);

        if (hidden > 0 || showAllFiles) {
            Button toggle = plainButton(showAllFiles ? "仅显示本次产出" : "显示全部历史文件");
            toggle.setOnClickListener(v -> {
                showAllFiles = !showAllFiles;
                renderFiles();
            });
            filesBox.addView(toggle);
        }

        if (shown.length() == 0) {
            filesBox.addView(hint("没有匹配的输出文件"));
            return;
        }

        final JSONArray shownRef = shown;
        Button all = primaryButton("全部传输到手机 (" + shown.length() + ")");
        all.setOnClickListener(v -> executor.execute(() -> transferAll(shownRef)));
        filesBox.addView(all);

        for (int i = 0; i < shown.length(); i++) {
            JSONObject file = shown.optJSONObject(i);
            if (file == null) continue;
            final JSONObject fileRef = file;
            LinearLayout item = card();
            item.addView(cardTitle(file.optString("name", "文件")));
            item.addView(subtitle(humanSize(file.optLong("bytes", 0))
                    + " · " + file.optString("contentType", "")));
            Button download = plainButton("传输到手机");
            download.setOnClickListener(v -> executor.execute(() -> transferFile(fileRef, true)));
            item.addView(download);
            filesBox.addView(item);
        }
    }

    private void transferAll(JSONArray files) {
        int ok = 0;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            if (transferFile(f, false)) ok++;
        }
        final int done = ok;
        ui(() -> {
            setStatus("已传输 " + done + " 个文件到 下载/ScriptWorkbench", OK_GREEN);
            toast("已传输 " + done + " 个文件");
        });
    }

    private boolean transferFile(JSONObject file, boolean openWhenDone) {
        String fileId = file.optString("fileId", "");
        String name = sanitize(file.optString("name", "download.bin"));
        String contentType = file.optString("contentType", "application/octet-stream");
        if (fileId.isEmpty()) return false;
        ui(() -> setStatus("传输中：" + name, ACCENT));
        HttpURLConnection connection = null;
        try {
            URL url = new URL(normalizedBaseUrl() + "/api/files/" + fileId + "/download");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            if (!token.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = connection.getResponseCode();
            if (code >= 400) {
                ui(() -> setStatus("传输失败 HTTP " + code + "：" + name, ERR_RED));
                return false;
            }
            long total = connection.getContentLengthLong();
            Uri saved = saveStream(connection.getInputStream(), name, contentType, total, "");
            if (saved == null) {
                ui(() -> setStatus("保存失败：" + name, ERR_RED));
                return false;
            }
            final Uri openUri = saved;
            ui(() -> {
                setStatus("已保存到手机：" + name, OK_GREEN);
                if (openWhenDone) openFile(openUri, contentType);
            });
            return true;
        } catch (Exception e) {
            ui(() -> setStatus("传输失败：" + e.getMessage(), ERR_RED));
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Uri saveStream(InputStream in, String name, String contentType, long total, String subDir)
            throws Exception {
        String relBase = "ScriptWorkbench";
        if (subDir != null && !subDir.isEmpty()) {
            relBase = relBase + "/" + subDir;
        }
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, contentType);
            values.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/" + relBase);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return null;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                copy(in, out, name, total);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, values, null, null);
            return uri;
        }
        File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), relBase);
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, name);
        try (OutputStream os = new FileOutputStream(out)) {
            copy(in, os, name, total);
        }
        return Uri.fromFile(out);
    }

    private void copy(InputStream in, OutputStream out, String name, long total)
            throws Exception {
        byte[] buf = new byte[65536];
        long done = 0;
        int n;
        int lastPct = -1;
        while ((n = in.read(buf)) != -1) {
            out.write(buf, 0, n);
            done += n;
            if (total > 0) {
                int pct = (int) (done * 100 / total);
                if (pct != lastPct) {
                    lastPct = pct;
                    final int p = pct;
                    ui(() -> setStatus("传输中 " + name + " " + p + "%", ACCENT));
                }
            }
        }
        out.flush();
    }

    private void openFile(Uri uri, String contentType) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri,
                    contentType == null || contentType.isEmpty() ? "*/*" : contentType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(intent, "打开文件"));
        } catch (Exception e) {
            toast("已保存，但没有可打开该类型的应用");
        }
    }

    // ---- http + helpers ----

    private String request(String method, String path, String body, boolean authorized)
            throws Exception {
        URL url = new URL(normalizedBaseUrl() + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(30000);
        if (authorized && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = connection.getResponseCode();
        String text = readBody(code >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (code >= 400) {
            throw new IllegalStateException("HTTP " + code + ": " + text);
        }
        return text;
    }

    private String readBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line).append('\n');
            }
        }
        return builder.toString();
    }

    private String normalizedBaseUrl() {
        String value = baseUrlInput.getText().toString().trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private void runNetwork(NetworkJob job) {
        setStatus("处理中...", TEXT_SECONDARY);
        executor.execute(() -> {
            try {
                job.run();
            } catch (Exception error) {
                ui(() -> setStatus(String.valueOf(error.getMessage()), ERR_RED));
            }
        });
    }

    private void ui(Runnable runnable) {
        main.post(runnable);
    }

    private void setStatus(String msg, int color) {
        statusText.setText(msg);
        statusText.setTextColor(color);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        double kb = bytes / 1024.0;
        if (kb < 1024) return String.format("%.1f KB", kb);
        double mb = kb / 1024.0;
        if (mb < 1024) return String.format("%.1f MB", mb);
        return String.format("%.1f GB", mb / 1024.0);
    }

    private String sanitize(String name) {
        String s = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (s.isEmpty()) return "download.bin";
        if (s.length() > 120) {
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && s.length() - dot <= 8) ? s.substring(dot) : "";
            s = s.substring(0, 120 - ext.length()) + ext;
        }
        return s;
    }

    private String tail(String value, int max) {
        return value.length() <= max ? value : value.substring(value.length() - max);
    }

    private Long epochMs(String iso) {
        if (iso == null || iso.isEmpty()) return null;
        try {
            return java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli();
        } catch (Exception e) {
            try {
                return java.time.Instant.parse(iso).toEpochMilli();
            } catch (Exception e2) {
                return null;
            }
        }
    }

    private String shortTime(String iso) {
        if (iso == null) return "";
        int t = iso.indexOf('T');
        if (t < 0 || iso.length() < t + 6) return iso;
        return iso.substring(t + 1, t + 6);
    }

    // ---- view builders ----

    private TextView title(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(24);
        v.setTextColor(TEXT_PRIMARY);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private TextView sectionTitle(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(17);
        v.setTextColor(TEXT_PRIMARY);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setPadding(dp(2), dp(16), 0, dp(8));
        return v;
    }

    private TextView cardTitle(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(16);
        v.setTextColor(TEXT_PRIMARY);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private TextView subtitle(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(13);
        v.setTextColor(TEXT_SECONDARY);
        v.setPadding(0, dp(2), 0, dp(8));
        return v;
    }

    private TextView fieldLabel(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(13);
        v.setTextColor(TEXT_SECONDARY);
        v.setPadding(0, dp(6), 0, dp(2));
        return v;
    }

    private TextView text(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(14);
        v.setTextColor(TEXT_PRIMARY);
        v.setPadding(0, dp(4), 0, dp(4));
        return v;
    }

    private TextView hint(String value) {
        TextView v = text(value);
        v.setTextColor(TEXT_SECONDARY);
        return v;
    }

    private EditText input(String value, String hint) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextColor(TEXT_PRIMARY);
        e.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return e;
    }

    private Button primaryButton(String value) {
        Button b = new Button(this);
        b.setText(value);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(ACCENT);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        return b;
    }

    private Button plainButton(String value) {
        Button b = new Button(this);
        b.setText(value);
        b.setAllCaps(false);
        b.setTextColor(ACCENT);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(TAB_IDLE_BG);
        bg.setStroke(dp(1), 0xFFD1D9E6);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        return b;
    }

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private LinearLayout row() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        l.setLayoutParams(lp);
        return l;
    }

    private View wrap(View v, float weight) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, weight);
        lp.leftMargin = dp(4);
        lp.rightMargin = dp(4);
        v.setLayoutParams(lp);
        return v;
    }

    private LinearLayout card() {
        LinearLayout l = column();
        l.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(CARD_BG);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0xFFE5E9F0);
        l.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        lp.bottomMargin = dp(6);
        l.setLayoutParams(lp);
        return l;
    }

    private interface NetworkJob {
        void run() throws Exception;
    }
}

