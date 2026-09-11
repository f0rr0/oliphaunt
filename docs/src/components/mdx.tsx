import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import {
  CapabilitySnapshot,
  EmbeddedPostgresModel,
  ExactExtensionRule,
  ExtensionArtifactFlow,
  FirstQueryFlow,
  LearnRouteMap,
  MobileStabilityContract,
  ModeMatrix,
  PerformanceResultsGrid,
  QuickstartPath,
  ReactNativeApproachTable,
  ReactNativeBoundaryMap,
  ReferenceLookup,
  ReleaseLookup,
  SdkGuideSummary,
  SdkGuideProof,
  SdkLanding,
  SdkChooser,
  ShipChecklist,
  SqliteMigrationMap,
  StartNextSteps,
  StartOutcome,
  TauriAppPattern,
  VerifyChecklist,
  WasmDataMovement,
  WasmRuntimeMap,
} from './oliphaunt';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Callout,
    Card,
    Cards,
    CapabilitySnapshot,
    EmbeddedPostgresModel,
    File,
    Files,
    Folder,
    Step,
    Steps,
    Tab,
    Tabs,
    ExactExtensionRule,
    ExtensionArtifactFlow,
    FirstQueryFlow,
    LearnRouteMap,
    MobileStabilityContract,
    ModeMatrix,
    PerformanceResultsGrid,
    QuickstartPath,
    ReactNativeApproachTable,
    ReactNativeBoundaryMap,
    ReferenceLookup,
    ReleaseLookup,
    SdkGuideSummary,
    SdkGuideProof,
    SdkLanding,
    SdkChooser,
    ShipChecklist,
    SqliteMigrationMap,
    StartNextSteps,
    StartOutcome,
    TauriAppPattern,
    VerifyChecklist,
    WasmDataMovement,
    WasmRuntimeMap,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
