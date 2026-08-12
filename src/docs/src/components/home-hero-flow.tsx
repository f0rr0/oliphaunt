'use client';

import {
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import { useRef } from 'react';
import { siPostgresql } from 'simple-icons';
import './home-hero-sculpture.css';

const SPRING = { stiffness: 170, damping: 24, mass: 0.72 };

export function HomeHeroFlow() {
  const figureRef = useRef<HTMLElement | null>(null);
  const inView = useInView(figureRef, { amount: 0.35, once: true });
  const reduceMotion = useReducedMotion();
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const rotateX = useSpring(useTransform(pointerY, [-1, 1], [4.5, -4.5]), SPRING);
  const rotateY = useSpring(useTransform(pointerX, [-1, 1], [-5.5, 5.5]), SPRING);
  const shiftX = useSpring(useTransform(pointerX, [-1, 1], [-7, 7]), SPRING);
  const shiftY = useSpring(useTransform(pointerY, [-1, 1], [-5, 5]), SPRING);

  return (
    <figure
      className="home-pg-sculpture"
      data-motion-state={inView ? 'entered' : 'idle'}
      onPointerLeave={() => {
        pointerX.set(0);
        pointerY.set(0);
      }}
      onPointerMove={(event) => {
        if (reduceMotion || event.pointerType === 'touch') {
          return;
        }

        const bounds = event.currentTarget.getBoundingClientRect();
        pointerX.set(((event.clientX - bounds.left) / bounds.width - 0.5) * 2);
        pointerY.set(((event.clientY - bounds.top) / bounds.height - 0.5) * 2);
      }}
      ref={figureRef}
    >
      <figcaption className="sr-only">
        An abstract layered PostgreSQL elephant sculpture representing the database embedded inside
        the application.
      </figcaption>

      <svg
        aria-hidden="true"
        className="home-pg-sculpture__field"
        preserveAspectRatio="none"
        viewBox="0 0 800 650"
      >
        <path d="M24 522C81 355 189 194 353 93C488 10 658 10 805 91" />
        <path d="M-8 573C76 393 192 250 366 149C496 73 646 64 790 128" />
        <path d="M22 629C117 445 236 310 391 220C508 152 644 133 772 175" />
        <path d="M559-38C503 65 521 155 585 231c70 83 176 93 262 68" />
        <path d="M632-28c-42 85-19 153 34 205 54 54 124 66 188 49" />
        <circle cx="418" cy="320" r="238" />
        <circle cx="418" cy="320" r="188" />
      </svg>

      <motion.div
        aria-hidden="true"
        className="home-pg-sculpture__stage"
        style={
          reduceMotion
            ? undefined
            : {
                rotateX,
                rotateY,
                x: shiftX,
                y: shiftY,
          }
        }
      >
        <svg
          className="home-pg-sculpture__assembly"
          preserveAspectRatio="xMidYMid meet"
          viewBox="0 0 640 640"
        >
          <defs>
            <linearGradient id="home-pg-stratum-mint" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#64d39a" stopOpacity="0.12" />
              <stop offset="0.72" stopColor="#64d39a" stopOpacity="0.018" />
              <stop offset="1" stopColor="#64d39a" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="home-pg-stratum-blue" x1="1" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#82b8dc" stopOpacity="0.11" />
              <stop offset="0.68" stopColor="#82b8dc" stopOpacity="0.014" />
              <stop offset="1" stopColor="#82b8dc" stopOpacity="0" />
            </linearGradient>
            <radialGradient id="home-pg-core-glow">
              <stop offset="0" stopColor="#5ed69a" stopOpacity="0.38" />
              <stop offset="0.35" stopColor="#5ed69a" stopOpacity="0.1" />
              <stop offset="1" stopColor="#5ed69a" stopOpacity="0" />
            </radialGradient>
            <clipPath id="home-pg-fragment-top" clipPathUnits="userSpaceOnUse">
              <path d="M-2-2h28v9.9H-2z" />
            </clipPath>
            <clipPath id="home-pg-fragment-middle" clipPathUnits="userSpaceOnUse">
              <path d="M-2 7.2h28v8.4H-2z" />
            </clipPath>
            <clipPath id="home-pg-fragment-bottom" clipPathUnits="userSpaceOnUse">
              <path d="M-2 14.8h28V27H-2z" />
            </clipPath>
          </defs>

          <g className="home-pg-sculpture__boundary">
            <path
              className="home-pg-sculpture__boundary-line home-pg-sculpture__boundary-line--outer"
              d="M112 151C146 72 239 51 332 77l163 46c75 21 105 100 70 174l-72 151c-32 68-109 102-181 84l-158-41c-77-20-108-103-77-176Z"
              pathLength="1"
            />
            <path
              className="home-pg-sculpture__boundary-line home-pg-sculpture__boundary-line--inner"
              d="M153 181c31-57 102-74 172-55l128 35c57 16 84 76 60 133l-54 126c-24 57-88 85-147 69l-123-34c-60-16-87-82-60-140Z"
              pathLength="1"
            />
          </g>

          <g className="home-pg-sculpture__strata">
            <path
              className="home-pg-sculpture__stratum home-pg-sculpture__stratum--one"
              d="M116 269c73-91 166-124 278-99 49 11 94 31 136 59-58-4-106 13-143 51-52 54-124 75-218 61Z"
            />
            <path
              className="home-pg-sculpture__stratum home-pg-sculpture__stratum--two"
              d="M113 353c67-56 145-80 235-71 83 8 139 45 169 109-57-21-112-22-166-3-80 27-159 16-238-35Z"
            />
            <path
              className="home-pg-sculpture__stratum home-pg-sculpture__stratum--three"
              d="M157 427c53-47 116-67 188-59 68 8 112 35 134 83-42-12-87-7-135 14-67 29-129 16-187-38Z"
            />
          </g>

          <g className="home-pg-sculpture__flow">
            <path
              className="home-pg-sculpture__flow-line home-pg-sculpture__flow-line--quiet"
              d="M29 411c92-16 153-64 230-99 89-41 181-61 352-7"
              pathLength="1"
            />
            <path
              className="home-pg-sculpture__flow-line home-pg-sculpture__flow-line--active"
              d="M36 447c97-44 168-97 260-121 103-27 188-11 310 48"
              pathLength="1"
            />
            <path
              className="home-pg-sculpture__flow-line home-pg-sculpture__flow-line--return"
              d="M59 478c94-20 164-54 244-61 93-9 173 17 276 91"
              pathLength="1"
            />
          </g>

          <g
            className="home-pg-sculpture__elephant"
            transform="translate(174 151) scale(12.2)"
          >
            <path className="home-pg-sculpture__elephant-ghost" d={siPostgresql.path} />
            <path
              className="home-pg-sculpture__elephant-outline"
              d={siPostgresql.path}
              pathLength="1"
            />
            <path
              className="home-pg-sculpture__elephant-fragment home-pg-sculpture__elephant-fragment--top"
              clipPath="url(#home-pg-fragment-top)"
              d={siPostgresql.path}
              pathLength="1"
              transform="translate(-.22 -.08)"
            />
            <path
              className="home-pg-sculpture__elephant-fragment home-pg-sculpture__elephant-fragment--middle"
              clipPath="url(#home-pg-fragment-middle)"
              d={siPostgresql.path}
              pathLength="1"
            />
            <path
              className="home-pg-sculpture__elephant-fragment home-pg-sculpture__elephant-fragment--bottom"
              clipPath="url(#home-pg-fragment-bottom)"
              d={siPostgresql.path}
              pathLength="1"
              transform="translate(.22 .12)"
            />
          </g>

          <g className="home-pg-sculpture__nodes">
            <circle className="home-pg-sculpture__node home-pg-sculpture__node--one" cx="73" cy="430" r="5" />
            <circle className="home-pg-sculpture__node home-pg-sculpture__node--two" cx="142" cy="384" r="4" />
            <circle className="home-pg-sculpture__core-halo" cx="322" cy="337" r="60" />
            <circle className="home-pg-sculpture__core-ring" cx="322" cy="337" r="20" />
            <circle className="home-pg-sculpture__node home-pg-sculpture__node--core" cx="322" cy="337" r="5" />
            <circle className="home-pg-sculpture__node home-pg-sculpture__node--three" cx="493" cy="340" r="4" />
            <circle className="home-pg-sculpture__node home-pg-sculpture__node--four" cx="570" cy="376" r="5" />
          </g>
        </svg>
      </motion.div>
    </figure>
  );
}
