import { siC, siKotlin, siReact, siRust, siSwift, siTypescript } from 'simple-icons';

export const sdkSurfaces = [
  { id: 'rust', title: 'Rust', target: 'Native apps and Tauri', icon: siRust.path },
  { id: 'typescript', title: 'TypeScript', target: 'Node.js, Bun, Deno, and Electron', icon: siTypescript.path },
  { id: 'swift', title: 'Swift', target: 'iOS and macOS', icon: siSwift.path },
  { id: 'kotlin', title: 'Kotlin', target: 'Android', icon: siKotlin.path },
  { id: 'react-native', title: 'React Native', target: 'React Native and Expo development builds', icon: siReact.path },
  { id: 'wasix-typescript', title: 'TypeScript · WASIX', target: 'Browsers and JavaScript runtimes', icon: siTypescript.path },
  { id: 'wasix-rust', title: 'Rust · WASIX', target: 'Rust apps using WebAssembly', icon: siRust.path },
  { id: 'c-abi', title: 'C / C++', target: 'Direct integration and language bindings', icon: siC.path },
] as const;
