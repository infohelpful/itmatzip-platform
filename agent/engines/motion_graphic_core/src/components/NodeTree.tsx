import React from "react";
import { Img, OffthreadVideo, Sequence, staticFile } from "remotion";

/** mg-core.js 가 만든 선언적 노드 {t, s, a, c} 를 React 요소로 바꾼다. */
export type MgNode = {
  t: string;
  s?: Record<string, unknown>;
  a?: Record<string, unknown>;
  c?: string | Array<MgNode | null>;
};

function resolveAsset(src: unknown): string {
  const name = typeof src === "object" && src !== null ? String((src as { asset?: string }).asset || "") : String(src || "");
  if (/^https?:\/\//i.test(name)) return name;
  return staticFile(name);
}

function renderNode(node: MgNode | null, key: string, compositionStart: number): React.ReactNode {
  if (!node) return null;
  const style = (node.s || {}) as React.CSSProperties;
  if (node.t === "img") {
    return <Img key={key} style={style} src={resolveAsset(node.a?.src)} />;
  }
  if (node.t === "video") {
    const from = Number(node.a?.startFrame || 0) - compositionStart;
    return <Sequence key={key} from={from} layout="none"><OffthreadVideo muted src={resolveAsset(node.a?.src)} style={style} /></Sequence>;
  }
  const props: Record<string, unknown> = { key, style };
  if (node.a) {
    // SVG 속성은 React 이름(strokeWidth)으로. viewBox·data-·aria- 는 그대로.
    for (const [name, value] of Object.entries(node.a)) {
      const key = /^(data|aria)-/.test(name) ? name : name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      props[key] = value;
    }
  }
  const children =
    typeof node.c === "string"
      ? node.c
      : Array.isArray(node.c)
        ? node.c.map((child, i) => renderNode(child, `${key}.${i}`, compositionStart))
        : undefined;
  return React.createElement(node.t, props, children);
}

export const NodeTree: React.FC<{ node: MgNode | null; compositionStart?: number }> = ({ node, compositionStart = 0 }) => <>{renderNode(node, "n", compositionStart)}</>;
