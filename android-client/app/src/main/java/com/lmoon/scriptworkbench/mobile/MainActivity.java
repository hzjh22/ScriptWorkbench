package com.lmoon.scriptworkbench.mobile;

import android.app.DownloadManager;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private EditText baseUrlInput;
    private EditText pairingCodeInput;
    private TextView statusText;
    private LinearLayout tasksBox;
    private LinearLayout runsBox;
    private LinearLayout filesBox;
    private TextView outputText;
    private String token = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SharedPreferences prefs = getSharedPreferences("script_workbench_mobile", MODE_PRIVATE);
        token = prefs.getString("token", "");

        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 32, 32, 32);
        scroll.addView(root);

        TextView title = title("ScriptWorkbench");
        root.addView(title);
        statusText = text("准备连接");
        root.addView(statusText);

        baseUrlInput = input(prefs.getString("base_url", "http://127.0.0.1:17631"), "电脑 API 地址");
        pairingCodeInput = input("", "配对码");
        root.addView(baseUrlInput);
        root.addView(pairingCodeInput);

        LinearLayout actions = row();
        Button pairButton = button("配对");
        pairButton.setOnClickListener(v -> pair());
        Button refreshButton = button("刷新");
        refreshButton.setOnClickListener(v -> refreshAll());
        actions.addView(pairButton);
        actions.addView(refreshButton);
        root.addView(actions);

        root.addView(sectionTitle("任务"));
        tasksBox = column();
        root.addView(tasksBox);

        root.addView(sectionTitle("运行记录"));
        runsBox = column();
        root.addView(runsBox);

        root.addView(sectionTitle("日志"));
        outputText = text("暂无日志");
        root.addView(outputText);

        root.addView(sectionTitle("输出文件"));
        filesBox = column();
        root.addView(filesBox);

        setContentView(scroll);
        if (!token.isEmpty()) {
            refreshAll();
        }
    }

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
                statusText.setText("配对成功");
                refreshAll();
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
                statusText.setText("已刷新");
            });
        });
    }

    private void renderTasks(JSONArray tasks) {
        tasksBox.removeAllViews();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) continue;
            LinearLayout item = card();
            item.addView(bold(task.optString("name", "未命名任务")));
            item.addView(text(task.optString("kind", "")));
            Button run = button("运行");
            run.setOnClickListener(v -> startRun(task.optString("id", "")));
            item.addView(run);
            tasksBox.addView(item);
        }
        if (tasks.length() == 0) tasksBox.addView(text("暂无任务"));
    }

    private void renderRuns(JSONArray runs) {
        runsBox.removeAllViews();
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.optJSONObject(i);
            if (run == null) continue;
            String runId = run.optString("id", "");
            LinearLayout item = card();
            item.addView(bold(run.optString("taskName", "运行") + " · " + run.optString("status", "")));
            item.addView(text(runId));
            LinearLayout actions = row();
            Button logs = button("日志");
            logs.setOnClickListener(v -> loadOutput(runId));
            Button files = button("文件");
            files.setOnClickListener(v -> loadFiles(runId));
            actions.addView(logs);
            actions.addView(files);
            if ("running".equals(run.optString("status", ""))) {
                Button stop = button("停止");
                stop.setOnClickListener(v -> stopRun(runId));
                actions.addView(stop);
            }
            item.addView(actions);
            runsBox.addView(item);
        }
        if (runs.length() == 0) runsBox.addView(text("暂无运行记录"));
    }

    private void startRun(String taskId) {
        if (taskId.isEmpty()) return;
        runNetwork(() -> {
            JSONObject body = new JSONObject();
            body.put("runtimeValues", new JSONObject());
            JSONObject run = new JSONObject(request("POST", "/api/tasks/" + taskId + "/run", body.toString(), true));
            ui(() -> {
                statusText.setText("已启动：" + run.optString("taskName", taskId));
                refreshAll();
            });
        });
    }

    private void stopRun(String runId) {
        runNetwork(() -> {
            request("POST", "/api/runs/" + runId + "/stop", "", true);
            ui(() -> {
                statusText.setText("已发送停止请求");
                refreshAll();
            });
        });
    }

    private void loadOutput(String runId) {
        runNetwork(() -> {
            JSONObject output = new JSONObject(request("GET", "/api/runs/" + runId + "/output", null, true));
            String stdout = output.optString("stdout", "");
            String stderr = output.optString("stderr", "");
            String merged = (stdout + "\n" + stderr).trim();
            ui(() -> outputText.setText(merged.isEmpty() ? "暂无日志" : tail(merged, 4000)));
        });
    }

    private void loadFiles(String runId) {
        runNetwork(() -> {
            JSONArray files = new JSONArray(request("GET", "/api/runs/" + runId + "/files", null, true));
            ui(() -> renderFiles(files));
        });
    }

    private void renderFiles(JSONArray files) {
        filesBox.removeAllViews();
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            if (file == null) continue;
            LinearLayout item = card();
            item.addView(bold(file.optString("name", "文件")));
            item.addView(text((file.optLong("bytes", 0) / 1024 / 1024) + " MB · " + file.optString("contentType", "")));
            Button download = button("下载");
            download.setOnClickListener(v -> enqueueDownload(file));
            item.addView(download);
            filesBox.addView(item);
        }
        if (files.length() == 0) filesBox.addView(text("暂无输出文件"));
    }

    private void enqueueDownload(JSONObject file) {
        String fileId = file.optString("fileId", "");
        String name = file.optString("name", "download.bin");
        DownloadManager.Request request = new DownloadManager.Request(
                Uri.parse(normalizedBaseUrl() + "/api/files/" + fileId + "/download"))
                .setTitle(name)
                .setDescription("ScriptWorkbench")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "ScriptWorkbench/" + name);
        if (!token.isEmpty()) {
            request.addRequestHeader("Authorization", "Bearer " + token);
        }
        getSystemService(DownloadManager.class).enqueue(request);
        statusText.setText("已加入系统下载器：" + name);
    }

    private String request(String method, String path, String body, boolean authorized) throws Exception {
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
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
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
        statusText.setText("处理中...");
        executor.execute(() -> {
            try {
                job.run();
            } catch (Exception error) {
                ui(() -> statusText.setText(error.getMessage()));
            }
        });
    }

    private void ui(Runnable runnable) {
        main.post(runnable);
    }

    private TextView title(String value) {
        TextView view = text(value);
        view.setTextSize(26);
        view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private TextView sectionTitle(String value) {
        TextView view = bold(value);
        view.setTextSize(20);
        view.setPadding(0, 24, 0, 8);
        return view;
    }

    private TextView bold(String value) {
        TextView view = text(value);
        view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private TextView text(String value) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(15);
        view.setPadding(0, 6, 0, 6);
        return view;
    }

    private EditText input(String value, String hint) {
        EditText editText = new EditText(this);
        editText.setText(value);
        editText.setHint(hint);
        editText.setSingleLine(true);
        editText.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        return editText;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setText(value);
        return button;
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        return layout;
    }

    private LinearLayout card() {
        LinearLayout layout = column();
        layout.setPadding(20, 20, 20, 20);
        return layout;
    }

    private String tail(String value, int max) {
        return value.length() <= max ? value : value.substring(value.length() - max);
    }

    private interface NetworkJob {
        void run() throws Exception;
    }
}
