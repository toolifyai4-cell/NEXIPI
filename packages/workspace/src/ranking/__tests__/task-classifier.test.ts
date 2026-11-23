import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  classifyTaskCategory,
  type TaskCategory,
  type TaskClassification,
} from '../task-classifier.js';

describe('TaskClassifier', () => {
  describe('bug-fixing classification', () => {
    it('classifies bug-fixing requests', () => {
      const result = classifyTask('Fix the authentication bug in the login form');
      expect(result.category).toBe('bug-fixing');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.matchedKeywords).toContain('fix');
      expect(result.matchedKeywords).toContain('bug');
    });

    it('classifies error resolution requests', () => {
      const result = classifyTask('Resolve the crash when submitting the form');
      expect(result.category).toBe('bug-fixing');
    });

    it('classifies defect patching', () => {
      const result = classifyTask('Patch the exception in the payment service');
      expect(result.category).toBe('bug-fixing');
    });
  });

  describe('feature-implementation classification', () => {
    it('classifies feature requests', () => {
      const result = classifyTask('Add a new API endpoint for user registration');
      expect(result.category).toBe('feature-implementation');
      expect(result.matchedKeywords).toContain('add');
      expect(result.matchedKeywords).toContain('endpoint');
    });

    it('classifies implementation requests', () => {
      const result = classifyTask('Implement real-time notifications using websockets');
      expect(result.category).toBe('feature-implementation');
    });

    it('classifies create requests', () => {
      const result = classifyTask('Create a new dashboard component');
      expect(result.category).toBe('feature-implementation');
    });
  });

  describe('refactoring classification', () => {
    it('classifies refactoring requests', () => {
      const result = classifyTask('Refactor the authentication service to use dependency injection');
      expect(result.category).toBe('refactoring');
    });

    it('classifies restructure requests', () => {
      const result = classifyTask('Restructure the project directory layout');
      expect(result.category).toBe('refactoring');
    });

    it('classifies cleanup requests', () => {
      const result = classifyTask('Clean up unused imports across the codebase');
      expect(result.category).toBe('refactoring');
    });
  });

  describe('testing classification', () => {
    it('classifies testing requests', () => {
      const result = classifyTask('Write unit tests for the user service');
      expect(result.category).toBe('testing');
    });

    it('classifies test case requests', () => {
      const result = classifyTask('Write unit tests for the user service');
      expect(result.category).toBe('testing');
    });

    it('classifies test runner requests', () => {
      const result = classifyTask('Run the vitest test suite for the checkout flow');
      expect(result.category).toBe('testing');
    });
  });

  describe('documentation classification', () => {
    it('classifies documentation requests', () => {
      const result = classifyTask('Write documentation comments for the public API');
      expect(result.category).toBe('documentation');
    });

    it('classifies docstring requests', () => {
      const result = classifyTask('Add docstrings and documentation to the source code');
      expect(result.category).toBe('documentation');
    });
  });

  describe('configuration classification', () => {
    it('classifies configuration requests', () => {
      const result = classifyTask('Configure the environment variables for production');
      expect(result.category).toBe('configuration');
    });

    it('classifies settings requests', () => {
      const result = classifyTask('Update the tsconfig.json compiler options');
      expect(result.category).toBe('configuration');
    });

    it('classifies env requests', () => {
      const result = classifyTask('Set up the .env file for database connection');
      expect(result.category).toBe('configuration');
    });
  });

  describe('architecture-exploration classification', () => {
    it('classifies architecture exploration requests', () => {
      const result = classifyTask('Explain how the application starts and the request flow');
      expect(result.category).toBe('architecture-exploration');
    });

    it('classifies structure requests', () => {
      const result = classifyTask('Overview of the project structure and component relationships');
      expect(result.category).toBe('architecture-exploration');
    });

    it('classifies how requests', () => {
      const result = classifyTask('How does the system architecture work?');
      expect(result.category).toBe('architecture-exploration');
    });
  });

  describe('debugging classification', () => {
    it('classifies debugging requests', () => {
      const result = classifyTask('Step through the code with a debugger and set breakpoints');
      expect(result.category).toBe('debugging');
    });

    it('classifies trace requests', () => {
      const result = classifyTask('Add logging and trace the execution path');
      expect(result.category).toBe('debugging');
    });

    it('classifies investigate requests', () => {
      const result = classifyTask('Investigate and diagnose the 500 error response');
      expect(result.category).toBe('debugging');
    });
  });

  describe('general-explanation classification', () => {
    it('classifies explanation requests', () => {
      const result = classifyTask('Describe what this component does');
      expect(result.category).toBe('general-explanation');
    });

    it('classifies describe requests', () => {
      const result = classifyTask('Explain what this code does');
      expect(result.category).toBe('general-explanation');
    });

    it('classifies what requests', () => {
      const result = classifyTask('What does this function do?');
      expect(result.category).toBe('general-explanation');
    });
  });

  describe('explicit category override', () => {
    it('respects explicit category override', () => {
      const result = classifyTask('random text with no keywords', {
        explicitCategory: 'feature-implementation',
      });
      expect(result.category).toBe('feature-implementation');
      expect(result.confidence).toBe(1.0);
      expect(result.reasons).toContain('Explicit task category override: feature-implementation');
    });

    it('override works for all categories', () => {
      for (const cat of ['bug-fixing', 'testing', 'documentation', 'configuration', 'debugging', 'general-explanation', 'architecture-exploration', 'refactoring'] as TaskCategory[]) {
        const result = classifyTask('anything', { explicitCategory: cat });
        expect(result.category).toBe(cat);
      }
    });
  });

  describe('ambiguous requests', () => {
    it('classifies ambiguous requests as unknown when no keywords match', () => {
      const result = classifyTask('hello world');
      expect(result.category).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('returns low confidence for weak matches', () => {
      const result = classifyTask('stuff');
      expect(result.category).toBe('unknown');
    });
  });

  describe('empty task descriptions', () => {
    it('returns unknown for empty string', () => {
      const result = classifyTask('');
      expect(result.category).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('returns unknown for whitespace-only string', () => {
      const result = classifyTask('   ');
      expect(result.category).toBe('unknown');
    });
  });

  describe('deterministic behavior', () => {
    it('produces identical results for identical inputs', () => {
      const query = 'Fix the authentication bug in the login service';
      const r1 = classifyTask(query);
      const r2 = classifyTask(query);
      expect(r1).toEqual(r2);
    });

    it('classifyTaskCategory returns just the category', () => {
      const cat = classifyTaskCategory('Fix the authentication bug');
      expect(cat).toBe('bug-fixing');
    });

    it('classifyTaskCategory with override returns override', () => {
      const cat = classifyTaskCategory('anything', { explicitCategory: 'testing' });
      expect(cat).toBe('testing');
    });
  });
});
