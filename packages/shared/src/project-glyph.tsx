import { type ProjectIcon } from "./project-appearance.js";

type GlyphShape =
  | { d: string }
  | { cx: number; cy: number; r: number }
  | { x: number; y: number; width: number; height: number; rx: number };

/**
 * The built-in project icons: original line drawings on a 24 unit grid,
 * stroked rather than filled, so one glyph reads on a colored tile and on a
 * plain button alike. Keyed by every name in `PROJECT_ICONS`, so an icon the
 * server can store always has a drawing.
 */
const GLYPHS: Readonly<Record<ProjectIcon, readonly GlyphShape[]>> = {
  grid: [{ x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.5 }, { x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1.5 }, { x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 }, { x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 }],
  compass: [{ cx: 12, cy: 12, r: 8.5 }, { d: "m15.5 8.5-2 5-5 2 2-5z" }],
  bolt: [{ d: "M13 3 5 13.5h6L10 21l8-10.5h-6z" }],
  globe: [{ cx: 12, cy: 12, r: 8.5 }, { d: "M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17" }],
  rocket: [{ d: "M12 3c3 2 4.5 5.5 4.5 9.5L14 15h-4l-2.5-2.5C7.5 8.5 9 5 12 3z" }, { d: "M10 15v4l2-1.5 2 1.5v-4" }, { cx: 12, cy: 9.2, r: 1.4 }],
  flask: [{ d: "M9.5 3.5h5M10.5 3.5V9L5.5 18a1.8 1.8 0 0 0 1.6 2.6h9.8a1.8 1.8 0 0 0 1.6-2.6l-5-9V3.5" }, { d: "M8 15h8" }],
  book: [{ d: "M5 4.5h10.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z" }, { d: "M5 17a3 3 0 0 1 3-3h10.5" }],
  briefcase: [{ x: 3.5, y: 7.5, width: 17, height: 12, rx: 2.5 }, { d: "M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17" }],
  chart: [{ d: "M4 20V4M4 20h16" }, { d: "M8.5 16v-4M12.5 16V8M16.5 16v-6" }],
  code: [{ d: "m8.5 7-5 5 5 5M15.5 7l5 5-5 5" }],
  cube: [{ d: "M12 3.5 20 8v8l-8 4.5L4 16V8z" }, { d: "m4 8 8 4.5L20 8M12 12.5v8" }],
  flag: [{ d: "M5.5 21V4M5.5 4.5h11l-2.5 4 2.5 4h-11" }],
  heart: [{ d: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" }],
  home: [{ d: "M4 11.5 12 4l8 7.5" }, { d: "M6 10v9.5h12V10" }, { d: "M10 19.5v-5h4v5" }],
  leaf: [{ d: "M5 19c0-9 5-14 14-14 0 9-5 14-14 14z" }, { d: "M5 19l8-8" }],
  pin: [{ d: "M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" }, { cx: 12, cy: 10, r: 2.3 }],
  pen: [{ d: "m4 20 1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z" }, { d: "m14.5 6 3 3" }],
  shield: [{ d: "M12 3.5 19 6v6c0 4.2-3 7.3-7 8.5-4-1.2-7-4.3-7-8.5V6z" }, { d: "m9 12 2.2 2.2L15 10.5" }],
  star: [{ d: "m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" }],
  terminal: [{ x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }, { d: "m7.5 9.5 3 2.5-3 2.5M12.5 14.5h4" }],
  layers: [{ d: "m12 4 8.5 4.5L12 13 3.5 8.5z" }, { d: "m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" }],
  music: [{ d: "M9 18V6l10-2v12" }, { cx: 6.5, cy: 18, r: 2.5 }, { cx: 16.5, cy: 16, r: 2.5 }],
  camera: [{ d: "M4 8.5h3l1.5-2.5h7L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z" }, { cx: 12, cy: 13.5, r: 3.2 }],
  cart: [{ d: "M3.5 4.5h2.5l2 10.5h9.5l2-7.5H7" }, { cx: 9.5, cy: 19, r: 1.4 }, { cx: 16.5, cy: 19, r: 1.4 }],
};

/** One built-in icon's strokes, drawn into the `<svg>` or `<g>` around them, which sets the stroke. */
export const ProjectGlyph = ({ icon }: { icon: ProjectIcon }) => (
  <>
    {GLYPHS[icon].map((shape, index) =>
      "d" in shape ? <path key={index} d={shape.d} />
        : "r" in shape ? <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />
          : <rect key={index} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />,
    )}
  </>
);
