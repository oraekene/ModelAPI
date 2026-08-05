/**
 * Scraper Registry — central dispatch for the Universal Scraper Network.
 *
 * The producer calls `planMessages(runId)` to get all queue messages from
 * all registered scrapers. The consumer calls `handle(msg, env)` to dispatch
 * a message to the correct scraper by its `kind` field.
 *
 * Usage:
 *   const registry = new ScraperRegistry();
 *   registry.register(new GroqScraper());
 *   registry.register(new TogetherScraper());
 *
 *   // Producer:
 *   const messages = registry.planMessages(runId);
 *
 *   // Consumer:
 *   const result = await registry.handle(msg, env);
 */

import type {
  Scraper,
  ScraperMessage,
  ScraperResult,
  ScraperEnv,
  SourceHealth,
  ScraperCategory,
} from './types';
import { BaseScraper } from './base';
import { GroqScraper } from './groq';
import { TogetherScraper } from './together';
import { FireworksScraper } from './fireworks';
import { CerebrasScraper } from './cerebras';
import { SambaNovaScraper } from './sambanova';
import { DeepInfraScraper } from './deepinfra';
import { NovitaScraper } from './novita';
import { HyperbolicScraper } from './hyperbolic';
import { SiliconFlowScraper } from './siliconflow';
import { NvidiaNimScraper } from './nvidia-nim';
import { ReplicateScraper } from './replicate';
import { BasetenScraper } from './baseten';
import { ModalScraper } from './modal';
import { LeptonScraper } from './lepton';
import { OctoAIScraper } from './octoai';
import { AnyscaleScraper } from './anyscale';
import { RunPodScraper } from './runpod';
import { LambdaScraper } from './lambda';
import { HfInferenceScraper } from './hf-inference';
import { CloudflareScraper } from './cloudflare';
import { FalScraper } from './fal';
import { PuterScraper } from './puter';
import { NebiusScraper } from './nebius';
import { ScalewayScraper } from './scaleway';
import { CoreWeaveScraper } from './coreweave';
import { BeamScraper } from './beam';
import { VastScraper } from './vast';
import { CrusoeScraper } from './crusoe';
import { InfercomScraper } from './infercom';
import { LyceumScraper } from './lyceum';
import { BergetScraper } from './berget';
import { NscaleScraper } from './nscale';
import { OvhcloudScraper } from './ovhcloud';
import { LibertAIScraper } from './libert';
import { TokenwareScraper } from './tokenware';
import { IonRouterScraper } from './ionrouter';
import { FerryAPIScraper } from './ferry';
import { HfHubScraper } from './hf-hub';
import { OpenAIScraper } from './openai';
import { AnthropicScraper } from './anthropic';
import { GeminiScraper } from './gemini';
import { LlamaScraper } from './llama';
import { MistralScraper } from './mistral';
import { XAIScraper } from './xai';
import { CohereScraper } from './cohere';
import { DeepSeekScraper } from './deepseek';
import { QwenScraper } from './qwen';
import { MoonshotScraper } from './moonshot';
import { ZhipuGLMScraper } from './zhipu-glm';
import { DoubaoScraper } from './doubao';
import { MiniMaxScraper } from './minimax';
import { ErnieScraper } from './ernie';
import { YiScraper } from './yi';
import { StabilityAIScraper } from './stability';
import { MidjourneyScraper } from './midjourney';
import { HunyuanScraper } from './hunyuan';
import { NovaScraper } from './nova';
import { PhiScraper } from './phi';
import { AI21Scraper } from './ai21';
import { PerplexityScraper } from './perplexity';
import { StepFunScraper } from './stepfun';
import { ZhipuAIScraper } from './zhipu-ai';
import { CursorScraper } from './cursor';
import { WindsurfScraper } from './windsurf';
import { CopilotScraper } from './copilot';
import { ClineScraper } from './cline';
import { AiderScraper } from './aider';
import { ContinueScraper } from './continue';
import { CodyScraper } from './cody';
import { TabnineScraper } from './tabnine';
import { AmazonQScraper } from './amazon-q';
import { JetBrainsScraper } from './jetbrains';
import { ReplitScraper } from './replit';
import { V0Scraper } from './v0';
import { BoltScraper } from './bolt';
import { LovableScraper } from './lovable';
import { DevinScraper } from './devin';
import { ZedScraper } from './zed';
import { AugmentScraper } from './augment';
import { FactoryScraper } from './factory';
import { KiroScraper } from './kiro';
import { WarpScraper } from './warp';
import { JulesScraper } from './jules';
import { CodexScraper } from './codex';
import { VoidScraper } from './void';
import { OpenClawScraper } from './openclaw';
import { OpenCodeScraper } from './opencode';
import { HermesScraper } from './hermes';
import { AmpScraper } from './amp';
import { GooseScraper } from './goose';
import { CrushScraper } from './crush';
import { CodexAgentScraper } from './codex-agent';
import { NemoClawScraper } from './nemoclaw';
import { CursorAgentScraper } from './cursor-agent';
import { GeminiCLIScraper } from './gemini-cli';
import { GrokBuildScraper } from './grok-build';

export {
  type Scraper,
  type ScraperMessage,
  type ScraperResult,
  type ScraperEnv,
  type SourceHealth,
  type ScraperCategory,
  BaseScraper,
  GroqScraper,
  TogetherScraper,
  FireworksScraper,
  CerebrasScraper,
  SambaNovaScraper,
  DeepInfraScraper,
  NovitaScraper,
  HyperbolicScraper,
  SiliconFlowScraper,
  NvidiaNimScraper,
  ReplicateScraper,
  BasetenScraper,
  ModalScraper,
  LeptonScraper,
  OctoAIScraper,
  AnyscaleScraper,
  RunPodScraper,
  LambdaScraper,
  HfInferenceScraper,
  CloudflareScraper,
  FalScraper,
  PuterScraper,
  NebiusScraper,
  ScalewayScraper,
  CoreWeaveScraper,
  BeamScraper,
  VastScraper,
  CrusoeScraper,
  InfercomScraper,
  LyceumScraper,
  BergetScraper,
  NscaleScraper,
  OvhcloudScraper,
  LibertAIScraper,
  TokenwareScraper,
  IonRouterScraper,
  FerryAPIScraper,
  HfHubScraper,
  OpenAIScraper,
  AnthropicScraper,
  GeminiScraper,
  LlamaScraper,
  MistralScraper,
  XAIScraper,
  CohereScraper,
  DeepSeekScraper,
  QwenScraper,
  MoonshotScraper,
  ZhipuGLMScraper,
  DoubaoScraper,
  MiniMaxScraper,
  ErnieScraper,
  YiScraper,
  StabilityAIScraper,
  MidjourneyScraper,
  HunyuanScraper,
  NovaScraper,
  PhiScraper,
  AI21Scraper,
  PerplexityScraper,
  StepFunScraper,
  ZhipuAIScraper,
  CursorScraper,
  WindsurfScraper,
  CopilotScraper,
  ClineScraper,
  AiderScraper,
  ContinueScraper,
  CodyScraper,
  TabnineScraper,
  AmazonQScraper,
  JetBrainsScraper,
  ReplitScraper,
  V0Scraper,
  BoltScraper,
  LovableScraper,
  DevinScraper,
  ZedScraper,
  AugmentScraper,
  FactoryScraper,
  KiroScraper,
  WarpScraper,
  JulesScraper,
  CodexScraper,
  VoidScraper,
  OpenClawScraper,
  OpenCodeScraper,
  HermesScraper,
  AmpScraper,
  GooseScraper,
  CrushScraper,
  CodexAgentScraper,
  NemoClawScraper,
  CursorAgentScraper,
  GeminiCLIScraper,
  GrokBuildScraper,
};

export class ScraperRegistry {
  private scrapers = new Map<string, Scraper>();
  private kindToScraper = new Map<string, Scraper>();

  /** Register a scraper. Overwrites any previous scraper with the same id. */
  register(scraper: Scraper): void {
    this.scrapers.set(scraper.id, scraper);
    // Each scraper's messages use `kind = scraper.id` by default.
    // If a scraper needs multiple message kinds, it overrides this.
    this.kindToScraper.set(scraper.id, scraper);
  }

  /** Unregister a scraper by id. */
  unregister(id: string): void {
    const scraper = this.scrapers.get(id);
    if (scraper) {
      this.scrapers.delete(id);
      this.kindToScraper.delete(scraper.id);
    }
  }

  /** Get a scraper by id. */
  get(id: string): Scraper | undefined {
    return this.scrapers.get(id);
  }

  /** Get all registered scrapers. */
  all(): Scraper[] {
    return Array.from(this.scrapers.values());
  }

  /** Get scrapers filtered by category. */
  byCategory(category: ScraperCategory): Scraper[] {
    return this.all().filter((s) => s.category === category);
  }

  /** Number of registered scrapers. */
  get size(): number {
    return this.scrapers.size;
  }

  /**
   * Plan all queue messages for a sync run.
   * Iterates every registered scraper and collects their messages.
   */
  planMessages(runId: string): ScraperMessage[] {
    const messages: ScraperMessage[] = [];
    for (const scraper of this.scrapers.values()) {
      messages.push(...scraper.planMessages(runId));
    }
    return messages;
  }

  /**
   * Dispatch a queue message to the correct scraper.
   * Looks up the scraper by `msg.kind`.
   * Throws if no scraper is registered for the given kind.
   */
  async handle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const scraper = this.kindToScraper.get(msg.kind);
    if (!scraper) {
      throw new Error(`No scraper registered for kind "${msg.kind}"`);
    }
    return scraper.handle(msg, env);
  }

  /**
   * Check if a message kind is handled by a registered scraper.
   */
  canHandle(kind: string): boolean {
    return this.kindToScraper.has(kind);
  }

  /**
   * Return health status for all registered scrapers.
   */
  healthAll(): SourceHealth[] {
    return this.all().map((s) => s.health());
  }
}

/**
 * Create a ScraperRegistry with the given scrapers pre-registered.
 */
export function createRegistry(...scrapers: Scraper[]): ScraperRegistry {
  const registry = new ScraperRegistry();
  for (const scraper of scrapers) {
    registry.register(scraper);
  }
  return registry;
}
