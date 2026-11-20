import React from "react";
import { AbsoluteFill, Audio, Freeze, OffthreadVideo, useCurrentFrame } from "remotion";
// @ts-expect-error — 순수 JS 공용 코어 (web-ui/tools/motion-graphic/mg-core.js 의 바이트 복사본)
import { composeFrame } from "./mg-core.js";
import { NodeTree, type MgNode } from "./components/NodeTree";

export type MainProps = {
  design: { width: number; height: number; fps: { num: number; den: number; value: number }; segments: unknown[]; style?: string };
  /** 원본 영상 URL (에이전트 /media 엔드포인트, Range 지원) */
  mediaUrl: string;
  /** 이 컴포지션의 0 프레임이 원본 타임라인에서 몇 프레임인지 */
  startFrame: number;
  durationInFrames: number;
};

type Frame = { zoom: { s: number; ox: number; oy: number }; fx: MgNode[]; full: MgNode | null; freeze: number | null };

/** 설계서 한 장으로 원본 + 모션그래픽 + 오디오를 한 번에 그린다 (브라우저 미리보기와 같은 composeFrame). */
export const Main: React.FC<MainProps> = ({ design, mediaUrl, startFrame }) => {
  const frame = useCurrentFrame();
  const W = design.width;
  const H = design.height;
  const st = composeFrame(design, startFrame + frame, { w: W, h: H, fps: design.fps.value }) as Frame;
  const { s, ox, oy } = st.zoom;
  const video = <OffthreadVideo src={mediaUrl} startFrom={startFrame} muted style={{ width: W, height: H }} />;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: `translate(${-ox}px, ${-oy}px) scale(${s})` }}>
        {st.freeze !== null ? <Freeze frame={Math.max(0, st.freeze - startFrame)}>{video}</Freeze> : video}
        <div style={{ position: "absolute", inset: 0 }}>
          {st.fx.map((n, i) => (
            <NodeTree key={i} node={n} compositionStart={startFrame} />
          ))}
        </div>
      </div>
      {st.full ? <NodeTree node={st.full} compositionStart={startFrame} /> : null}
      <Audio src={mediaUrl} startFrom={startFrame} />
    </AbsoluteFill>
  );
};
