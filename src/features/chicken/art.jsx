// Рисунок курицы и цыплёнка (SVG). Каждая часть — отдельная группа с классом,
// анимации и позы задаёт chicken.css по классу состояния на обёртке.
import { memo } from "react";

const STAR = "M0 -3 L0.9 -0.9 L3 0 L0.9 0.9 L0 3 L-0.9 0.9 L-3 0 L-0.9 -0.9 Z";

export const HenSvg = memo(function HenSvg() {
  return (
    <svg viewBox="0 0 100 100" className="ck-svg" aria-hidden="true">
      <g className="ck-pose">
        <g className="ck-legs">
          <g className="ck-leg ck-leg--b">
            <path className="ck-shin" d="M54 76 V92" />
            <path className="ck-foot" d="M49 93.5 L54 92 L60 93.5 M54 92 L55.5 95.5" />
          </g>
          <g className="ck-leg ck-leg--a">
            <path className="ck-shin" d="M45 76 V92" />
            <path className="ck-foot" d="M40 93.5 L45 92 L51 93.5 M45 92 L46.5 95.5" />
          </g>
        </g>
        <g className="ck-bodyg">
          <g className="ck-tail">
            <path className="ck-f2" d="M27 60 C 16 55 11 44 15 34 C 21 41 26 47 31 52 Z" />
            <path className="ck-f1" d="M29 56 C 22 46 22 35 28 27 C 31 36 33 44 36 51 Z" />
          </g>
          <ellipse className="ck-f0" cx="50" cy="64" rx="25" ry="17" />
          <ellipse className="ck-f0" cx="58" cy="52" rx="13" ry="14" />
          <path className="ck-shade" d="M29 69 C 38 80 60 83 73 69 C 66 79 40 83 29 69 Z" />
          <g className="ck-wing">
            <path className="ck-f2" d="M36 60 C 42 52 57 53 62 61 C 60 70 51 74 43 72 C 37 70 33 65 36 60 Z" />
            <path className="ck-wingline" d="M42 66.5 C 47 68.5 52 68.5 56 66.5 M40 62 C 46 64 53 64 59 62" />
          </g>
          <g className="ck-head">
            <circle className="ck-f0" cx="64" cy="36" r="13" />
            <path className="ck-comb" d="M55 26 C 53 19 58 16 60.5 21 C 61 14 68 13.5 68.5 20 C 71 15.5 77 18 74 25 C 68 23 61 23 55 26 Z" />
            <path className="ck-wattle" d="M75 41.5 C 73.5 48 77.5 51 80 47.5 C 81 45 79 42.5 75 41.5 Z" />
            <path className="ck-beak-lo" d="M75.5 38.2 L84.5 38.6 L75.5 41.8 Z" />
            <path className="ck-beak-up" d="M75.5 33.5 L87 37.6 L75.5 38.8 Z" />
            <g className="ck-eye">
              <circle className="ck-white" cx="69" cy="33" r="4.3" />
              <circle className="ck-pupil" cx="69" cy="33" r="2.4" />
              <circle className="ck-glint" cx="70" cy="32" r="0.8" />
              <rect className="ck-lid" x="64.2" y="28.4" width="9.6" height="9.6" />
            </g>
            <path className="ck-happy" d="M65.5 34 Q69 30.2 72.5 34" />
            <path className="ck-shut" d="M65 33 Q69 35.6 73 33" />
            <path className="ck-brow" d="M64.2 27.6 L73.8 30.8" />
            <g className="ck-helm">
              <path d="M50 28.5 C 49.5 13 77 9 79.5 24.5 L 81 28.5 Z" />
              <path className="ck-helm-rim" d="M49 28.5 H 82.5" />
              <path className="ck-helm-strap" d="M56.5 29 C 55.5 37 57.5 43 63 47" />
            </g>
            <g className="ck-phones">
              <path className="ck-phones-band" d="M53 33 C 51 16 76 14 77.5 27" />
              <rect x="54.5" y="30.5" width="9" height="12" rx="3.4" />
              <rect className="ck-phones-led" x="56.2" y="33" width="2.2" height="7" rx="1" />
            </g>
            <g className="ck-steam">
              <circle cx="57" cy="18" r="3" />
              <circle cx="65" cy="14" r="2.4" />
              <circle cx="51" cy="15" r="2" />
            </g>
            <g className="ck-stars">
              <path d={STAR} transform="translate(53 19)" />
              <path d={STAR} transform="translate(75 19)" />
              <path d={STAR} transform="translate(64 12) scale(.8)" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
});

export const ChickSvg = memo(function ChickSvg() {
  return (
    <svg viewBox="0 0 40 40" className="ck-chick__svg" aria-hidden="true">
      <g className="ck-chick__legs">
        <path d="M17 30 V37 M14.5 37.5 H19.5 M23 30 V37 M20.5 37.5 H25.5" />
      </g>
      <g className="ck-chick__body">
        <circle cx="20" cy="25" r="10" fill="#f7d154" />
        <ellipse cx="16.5" cy="26" rx="5" ry="3.6" fill="#ecc140" />
        <circle cx="26" cy="15.5" r="7" fill="#f9dc6b" />
        <path d="M25 9 C 24 5.5 27.5 5.5 26.8 9" fill="none" stroke="#ecc140" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M32.5 15 L37.5 16.6 L32.5 18.2 Z" fill="#f08a24" />
        <circle cx="28.6" cy="14.4" r="1.5" fill="#12151a" />
        <circle cx="29.1" cy="13.9" r=".45" fill="#fff" />
      </g>
    </svg>
  );
});

export const FEATHER = '<svg viewBox="0 0 20 10" width="14" height="7"><path d="M1 5 C 5 0 14 0 19 5 C 14 10 5 10 1 5 Z" fill="#f3eee4"/><path d="M1 5 H 18" stroke="#cdbfa6" stroke-width=".8"/></svg>';
