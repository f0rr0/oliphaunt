import { siC, siKotlin, siReact, siRust, siSwift, siTypescript } from 'simple-icons';

export const sdkSurfaces = [
  {
    id: 'wasix-typescript',
    title: 'WASIX TypeScript',
    target: 'Browsers, Node.js, Bun, Deno, and Electron',
    icon: siTypescript.path,
  },
  { id: 'swift', title: 'Swift', target: 'iOS and macOS', icon: siSwift.path },
  { id: 'kotlin', title: 'Kotlin', target: 'Android', icon: siKotlin.path },
  {
    id: 'react-native',
    title: 'React Native',
    target: 'iOS and Android, including Expo native builds',
    icon: siReact.path,
  },
  {
    id: 'wasix-rust',
    title: 'WASIX Rust',
    target: 'Rust desktop apps and Tauri',
    icon: siRust.path,
  },
  { id: 'rust', title: 'Native Rust', target: 'Rust desktop apps and Tauri', icon: siRust.path },
  {
    id: 'typescript',
    title: 'Native TypeScript',
    target: 'Node.js, Bun, Deno, and Electron',
    icon: siTypescript.path,
  },
  {
    id: 'c-abi',
    title: 'C / C++',
    target: 'Direct integration and language bindings',
    icon: siC.path,
  },
] as const;
