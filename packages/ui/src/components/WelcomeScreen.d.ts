import type { WelcomePrompt } from '../types';
interface WelcomeScreenProps {
  prompts: WelcomePrompt[];
  onPromptSelect: (prompt: string) => void;
}
export declare function WelcomeScreen({
  prompts,
  onPromptSelect,
}: WelcomeScreenProps): import('react').JSX.Element;
export {};
