import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import "./CodeEditor.css";

export type CodeEditorLanguage = "json";

export interface CodeEditorProps {
  /** 编辑器内容（受控）。外部改写（格式化 / 重置）会同步到模型。 */
  value: string;
  /** 用户输入时回调，参数为当前完整文本。 */
  onChange: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  /** 数字按 px 处理；字符串原样作为 CSS 高度。默认 360。 */
  height?: number | string;
  onMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  ariaLabel?: string;
}

const JSON_SYNTAX_OWNER = "teamstudio-json-syntax";

let environmentReady = false;

/**
 * monaco 0.57 的 JSON 语言服务通过 MonacoEnvironment 取 worker。
 * 这里按 label 分发：JSON 请求 → json.worker，其余（编辑器基础能力）→ editor.worker。
 * 全部使用 Vite `?worker` 本地打包，不依赖任何 CDN / AMD loader。
 */
function configureMonacoEnvironment() {
  if (environmentReady) return;
  const scope = self as unknown as { MonacoEnvironment?: monaco.Environment };
  scope.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      return label === "json" ? new JsonWorker() : new EditorWorker();
    },
  };
  // 双重保险：开启 JSON 语言服务自带的严格语法诊断（worker），
  // 同时在组件内用 JSON.parse + setModelMarkers 标注错误行列，
  // 即使 worker 因浏览器策略不可用，错误行也一定能看到红色波浪线。
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    comments: "error",
    trailingCommas: "error",
    schemas: [],
    enableSchemaRequest: false,
    schemaValidation: "ignore",
  });
  environmentReady = true;
}

function readTheme(): "vs" | "vs-dark" {
  return document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";
}

interface JsonErrorSpot {
  line: number;
  column: number;
  length: number;
}

function offsetToSpot(text: string, offset: number): JsonErrorSpot {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  const column = clamped - lastBreak; // lastBreak === -1 → column = clamped + 1
  return { line, column, length: 1 };
}

/** 从 V8 的 JSON.parse 错误信息里推断错误行列，用于 monaco 标记。 */
function locateJsonError(message: string, text: string): JsonErrorSpot {
  const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]), length: 1 };
  }
  const position = message.match(/position\s+(\d+)/i);
  if (position) return offsetToSpot(text, Number(position[1]));
  if (/unexpected end of json input/i.test(message)) {
    return offsetToSpot(text, text.length);
  }
  return offsetToSpot(text, 0);
}

function applyJsonMarkers(model: monaco.editor.ITextModel, text: string) {
  const markers: monaco.editor.IMarkerData[] = [];
  if (text.trim()) {
    try {
      JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "JSON 语法错误";
      const spot = locateJsonError(message, text);
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: spot.line,
        startColumn: spot.column,
        endLineNumber: spot.line,
        endColumn: spot.column + spot.length,
      });
    }
  }
  monaco.editor.setModelMarkers(model, JSON_SYNTAX_OWNER, markers);
}

/**
 * VS Code 同款编辑器（monaco-editor ESM，本地 worker）。
 * - 主题跟随 `document.documentElement.dataset.theme`（MutationObserver 实时切换 vs / vs-dark）；
 * - JSON 语法错误用 setModelMarkers 标注在出错行列；
 * - 容器自适应（automaticLayout），高度由 height 控制。
 */
export function CodeEditor({
  value,
  onChange,
  language = "json",
  readOnly = false,
  height = 360,
  onMount,
  ariaLabel = "JSON 编辑器",
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onMountRef = useRef(onMount);
  /** 外部值写入模型时抑制 onChange，避免重置/同步操作被误判成用户输入。 */
  const applyingExternalRef = useRef(false);

  onChangeRef.current = onChange;
  onMountRef.current = onMount;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    configureMonacoEnvironment();
    monaco.editor.setTheme(readTheme());

    const model = monaco.editor.createModel(value, language);
    applyJsonMarkers(model, value);
    const editor = monaco.editor.create(host, {
      model,
      theme: readTheme(),
      readOnly,
      ariaLabel,
      automaticLayout: true,
      fontSize: 12,
      lineHeight: 20,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontLigatures: false,
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: false },
      glyphMargin: false,
      folding: true,
      lineNumbersMinChars: 3,
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      padding: { top: 10, bottom: 10 },
      overviewRulerLanes: 0,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;

    const subscription = model.onDidChangeContent(() => {
      const next = model.getValue();
      applyJsonMarkers(model, next);
      if (applyingExternalRef.current) return;
      onChangeRef.current(next);
    });

    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(readTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    onMountRef.current?.(editor);

    return () => {
      themeObserver.disconnect();
      subscription.dispose();
      editorRef.current = null;
      editor.dispose();
      model.dispose();
    };
    // 编辑器实例只在挂载时创建一次，props 变化通过下面的 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值（格式化、恢复服务器版本、从草稿同步）同步进模型。
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getValue() === value) return;
    const position = editor.getPosition();
    applyingExternalRef.current = true;
    try {
      model.setValue(value);
      applyJsonMarkers(model, value);
    } finally {
      applyingExternalRef.current = false;
    }
    if (position) editor.setPosition(position);
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  const resolvedHeight = typeof height === "number" ? `${height}px` : height;

  return (
    <div className="code-editor" style={{ height: resolvedHeight }}>
      <div className="code-editor-host" ref={hostRef} />
    </div>
  );
}

export default CodeEditor;
