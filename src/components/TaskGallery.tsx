import { useMemo } from "react";
import type { TaskRecord } from "../types";

export interface TaskGalleryProps {
  tasks: TaskRecord[];
  search: string;
  onSearch: (value: string) => void;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  onRun: (task: TaskRecord) => void;
  onEdit: (task: TaskRecord) => void;
  onToggleFavorite: (taskId: string) => void;
  onNewTask: () => void;
  onNewCommand: () => void;
  onRefresh: () => void;
  runningTaskIds: Set<string>;
  runningTaskCounts: Record<string, number>;
  lanShareActive: boolean;
  onOpenLanShare: () => void;
}

export function TaskGallery(props: TaskGalleryProps) {
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    map.set("all", props.tasks.length);
    map.set("favorite", props.tasks.filter((t) => t.favorite).length);
    map.set("python", props.tasks.filter((t) => t.kind === "python_task").length);
    map.set("command", props.tasks.filter((t) => t.kind === "command_task").length);
    for (const task of props.tasks) {
      for (const tag of task.tags ?? []) {
        if (!tag.trim()) continue;
        map.set(tag, (map.get(tag) ?? 0) + 1);
      }
    }
    return map;
  }, [props.tasks]);

  const tagCategories = useMemo(
    () =>
      [...categoryCounts.entries()].filter(
        ([key]) => !["all", "favorite", "python", "command"].includes(key),
      ),
    [categoryCounts],
  );

  const filteredTasks = useMemo(() => {
    const cat = props.selectedCategory;
    const q = props.search.trim().toLowerCase();
    return props.tasks.filter((task) => {
      if (cat === "favorite" && !task.favorite) return false;
      if (cat === "python" && task.kind !== "python_task") return false;
      if (cat === "command" && task.kind !== "command_task") return false;
      if (!["all", "favorite", "python", "command"].includes(cat)) {
        if (!(task.tags ?? []).includes(cat)) return false;
      }
      if (q) {
        const haystack = [
          task.name,
          task.kind === "python_task" ? task.python?.scriptPath : task.command?.command,
          ...(task.tags ?? []),
          task.notes,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [props.tasks, props.selectedCategory, props.search]);

  function categoryLabel(key: string): string {
    switch (key) {
      case "all":
        return "全部任务";
      case "favorite":
        return "我的收藏";
      case "python":
        return "Python";
      case "command":
        return "命令";
      default:
        return key;
    }
  }

  function categoryIcon(key: string): string {
    switch (key) {
      case "all":
        return "📋";
      case "favorite":
        return "⭐";
      case "python":
        return "🐍";
      case "command":
        return "⚡";
      default:
        return "🏷️";
    }
  }

  return (
    <div className="gallery-shell">
      <aside className="gallery-sidebar">
        <div className="gallery-brand">
          <div className="gallery-brand-mark">SW</div>
          <div className="gallery-brand-text">
            <strong>Script Workbench</strong>
            <span>内置终端的脚本工作台</span>
          </div>
        </div>
        <nav className="gallery-categories">
          {(["all", "favorite", "python", "command"] as const).map((key) => (
            <button
              key={key}
              className={`gallery-cat ${props.selectedCategory === key ? "active" : ""}`}
              onClick={() => props.onSelectCategory(key)}
            >
              <span className="gallery-cat-label">
                <span className="gallery-cat-icon">{categoryIcon(key)}</span>
                {categoryLabel(key)}
              </span>
              <span className="gallery-cat-count">{categoryCounts.get(key) ?? 0}</span>
            </button>
          ))}
          {tagCategories.length > 0 && (
            <div className="gallery-cat-divider">
              <span>标签分类</span>
            </div>
          )}
          {tagCategories.map(([tag, count]) => (
            <button
              key={tag}
              className={`gallery-cat ${props.selectedCategory === tag ? "active" : ""}`}
              onClick={() => props.onSelectCategory(tag)}
            >
              <span className="gallery-cat-label">
                <span className="gallery-cat-icon">🏷️</span>
                {tag}
              </span>
              <span className="gallery-cat-count">{count}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="gallery-main">
        <header className="gallery-topbar">
          <div className="gallery-search-wrap">
            <span className="gallery-search-icon">🔍</span>
            <input
              className="gallery-search"
              placeholder="搜索任务名称、脚本路径、标签..."
              value={props.search}
              onChange={(event) => props.onSearch(event.currentTarget.value)}
            />
          </div>
          <div className="gallery-topbar-actions">
            <button className="gallery-btn ghost" onClick={props.onRefresh} title="刷新任务列表">
              刷新
            </button>
            <button
              className={`gallery-btn lan-share-btn ${props.lanShareActive ? "active" : ""}`}
              onClick={props.onOpenLanShare}
              title="局域网共享"
            >
              <span className={`lan-share-dot ${props.lanShareActive ? "on" : ""}`} />
              {props.lanShareActive ? "共享中" : "局域网共享"}
            </button>
            <button className="gallery-btn secondary" onClick={props.onNewCommand}>
              新建命令
            </button>
            <button className="gallery-btn primary" onClick={props.onNewTask}>
              新建 Python
            </button>
          </div>
        </header>

        <div className="gallery-grid">
          {filteredTasks.map((task) => {
            const taskId = task.id ?? "";
            const isRunning = taskId ? props.runningTaskIds.has(taskId) : false;
            const runningCount = taskId ? props.runningTaskCounts[taskId] ?? 0 : 0;
            return (
              <div key={taskId || task.name} className={`gallery-card ${isRunning ? "running" : ""}`}>
                <div className="gallery-card-header">
                  <strong className="gallery-card-title" title={task.name}>
                    {task.name || "未命名任务"}
                  </strong>
                  <div className="gallery-card-actions">
                    <button
                      className={`gallery-icon-btn ${task.favorite ? "favorited" : ""}`}
                      onClick={() => taskId && props.onToggleFavorite(taskId)}
                      title={task.favorite ? "取消收藏" : "收藏"}
                    >
                      {task.favorite ? "★" : "☆"}
                    </button>
                    <button
                      className="gallery-icon-btn"
                      onClick={() => props.onEdit(task)}
                      title="编辑任务配置"
                    >
                      ✎
                    </button>
                  </div>
                </div>
                <p className="gallery-card-desc">
                  {task.kind === "python_task"
                    ? task.python?.scriptPath || "未设置脚本路径"
                    : task.command?.command || "未设置命令"}
                </p>
                <div className="gallery-card-meta">
                  <span className={`gallery-card-kind ${task.kind === "python_task" ? "python" : "command"}`}>
                    {task.kind === "python_task" ? "Python" : "命令"}
                  </span>
                  {(task.tags ?? []).slice(0, 2).map((tag) => (
                    <span key={tag} className="gallery-card-tag">
                      {tag}
                    </span>
                  ))}
                  {isRunning && (
                    <span className="gallery-card-running">
                      运行中{runningCount > 1 ? ` ×${runningCount}` : ""}
                    </span>
                  )}
                </div>
                <div className="gallery-card-footer">
                  <button
                    className={`gallery-run-btn ${isRunning ? "running" : ""}`}
                    onClick={() => props.onRun(task)}
                  >
                    {isRunning ? "查看运行" : "▶ 运行"}
                  </button>
                </div>
              </div>
            );
          })}
          {filteredTasks.length === 0 && (
            <div className="gallery-empty">
              <p>没有匹配的任务</p>
              <span>尝试调整搜索关键词或分类筛选</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
