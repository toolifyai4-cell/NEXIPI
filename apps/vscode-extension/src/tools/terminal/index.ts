/**
 * Phase 11 Stage E — Terminal approval and execution lifecycle.
 *
 * Public exports for the trusted terminal-command approval and execution
 * orchestrator and its trusted authorization verifier.
 */

export {
  TerminalApprovalOrchestrator,
  type TerminalApprovalOrchestratorOptions,
} from './terminal-approval-orchestrator.js';

export {
  TerminalTrustedAuthorizationVerifier,
  type TerminalTrustedAuthorizationVerifierOptions,
} from './terminal-trusted-authorization-verifier.js';
