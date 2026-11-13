import '@testing-library/jest-dom';

Object.defineProperty(window, 'parent', {
  value: window,
  writable: true,
});
