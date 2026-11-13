import { post } from './api';
import type { DomainSetupStep } from './types';

// A step reports "running" while Cloudflare finishes turning on Email Routing, which can take a
// minute or two (#28). Ask again every 5 seconds, for about 2 minutes.
const POLL_MS = 5000;
const POLLS = 28;

// Runs the domain's setup steps one request at a time, until they are done or one fails.
export async function runDomainSetup(domainId: number, onSteps: (s: DomainSetupStep[]) => void, reset = false): Promise<{ done: boolean; error?: string; step?: string }> {
  let waiting: DomainSetupStep | undefined;
  for (let i = 0; i < POLLS; i++) {
    const r = await post<{ steps: DomainSetupStep[]; done: boolean }>(`/admin/domains/${domainId}/setup${i === 0 && reset ? '?reset=1' : ''}`);
    onSteps(r.steps);
    if (r.done) return { done: true };
    const failed = r.steps.find((s) => s.status === 'error');
    if (failed) return { done: false, error: failed.message ?? 'A step failed.', step: failed.label };
    waiting = r.steps.find((s) => s.status === 'running');
    if (waiting) await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return waiting
    ? { done: false, error: 'Cloudflare still has not finished turning on Email Routing. It can take a few minutes: retry shortly.', step: waiting.label }
    : { done: false };
}
