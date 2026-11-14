import '@testing-library/jest-dom';
import { vi } from 'vitest';

Object.defineProperty(window, 'parent', {
  value: window,
  writable: true,
});

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock matchMedia for components that use it
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));
