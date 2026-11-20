import React from "react";
import { Composition } from "remotion";
import { Main, type MainProps } from "./Main";

const defaults: MainProps = {
  design: { width: 1920, height: 1080, fps: { num: 30, den: 1, value: 30 }, segments: [] },
  mediaUrl: "",
  startFrame: 0,
  durationInFrames: 30,
};

export const Root: React.FC = () => (
  <Composition
    id="Main"
    component={Main}
    fps={30}
    width={1920}
    height={1080}
    durationInFrames={30}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({
      width: Math.max(2, Math.round(props.design.width)),
      height: Math.max(2, Math.round(props.design.height)),
      fps: props.design.fps.num / props.design.fps.den,
      durationInFrames: Math.max(1, Math.round(props.durationInFrames)),
    })}
  />
);
