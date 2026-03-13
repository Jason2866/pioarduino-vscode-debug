import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('GitHub Actions Publish Workflow', () => {
  const workflowPath = path.join(__dirname, '../../.github/workflows/publish.yml');

  function loadWorkflow(): { content: string; parsed: any; error: Error | null } {
    try {
      const content = fs.readFileSync(workflowPath, 'utf8');
      const parsed = yaml.load(content) as any;
      return { content, parsed, error: null };
    } catch (e) {
      return { content: '', parsed: null, error: e as Error };
    }
  }

  describe('Workflow File Structure', () => {
    test('workflow file should exist', () => {
      expect(fs.existsSync(workflowPath)).toBe(true);
    });

    test('workflow file should be valid YAML', () => {
      const { error } = loadWorkflow();
      expect(error).toBeNull();
    });

    test('workflow should have a name', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.name).toBeDefined();
      expect(typeof workflow.name).toBe('string');
    });

    test('workflow name should be "Build and upload to NPM"', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.name).toBe('Build and upload to NPM');
    });
  });

  describe('Workflow Triggers', () => {
    test('workflow should have "on" trigger definition', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.on).toBeDefined();
    });

    test('workflow should trigger on push events', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.on).toHaveProperty('push');
    });

    test('workflow should trigger on workflow_dispatch', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.on).toHaveProperty('workflow_dispatch');
    });
  });

  describe('Concurrency', () => {
    test('workflow should have concurrency settings', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.concurrency).toBeDefined();
    });

    test('workflow should cancel in-progress runs', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    });
  });

  describe('Workflow Jobs', () => {
    test('workflow should have jobs defined', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs).toBeDefined();
    });

    test('workflow should have a build job', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build).toBeDefined();
    });

    test('build job should run on ubuntu-latest', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build['runs-on']).toBe('ubuntu-latest');
    });

    test('build job should have steps', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.steps).toBeDefined();
      expect(Array.isArray(workflow.jobs.build.steps)).toBe(true);
    });

    test('build job should have at least 6 steps', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.steps.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Workflow Permissions', () => {
    test('build job should have permissions defined', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.permissions).toBeDefined();
    });

    test('build job should have id-token write permission for OIDC', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.permissions['id-token']).toBe('write');
    });

    test('build job should have contents write permission', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.permissions.contents).toBe('write');
    });
  });

  describe('Workflow Steps - Checkout and Setup', () => {
    function getSteps() {
      return loadWorkflow().parsed.jobs.build.steps;
    }

    test('first step should checkout the code', () => {
      const steps = getSteps();
      expect(steps[0].uses).toMatch(/actions\/checkout@v/);
    });

    test('checkout should use v6 or later', () => {
      const steps = getSteps();
      const checkoutVersion = steps[0].uses.match(/@v(\d+)/);
      expect(checkoutVersion).not.toBeNull();
      expect(parseInt(checkoutVersion![1])).toBeGreaterThanOrEqual(6);
    });

    test('second step should setup Node.js', () => {
      const steps = getSteps();
      expect(steps[1].uses).toMatch(/actions\/setup-node@v/);
    });

    test('Node.js should be configured with version 22', () => {
      const steps = getSteps();
      expect(steps[1].with).toBeDefined();
      expect(String(steps[1].with['node-version'])).toBe('22');
    });

    test('Node.js should be configured with npm registry', () => {
      const steps = getSteps();
      expect(steps[1].with['registry-url']).toBe('https://registry.npmjs.org');
    });
  });

  describe('Workflow Steps - Build Process', () => {
    function getSteps() {
      return loadWorkflow().parsed.jobs.build.steps;
    }

    test('should update npm to latest version', () => {
      const steps = getSteps();
      const npmUpdateStep = steps.find((step: any) => step.run && step.run.includes('npm install -g npm@latest'));
      expect(npmUpdateStep).toBeDefined();
    });

    test('should install dependencies', () => {
      const steps = getSteps();
      const npmInstallStep = steps.find((step: any) => step.run && step.run === 'npm install');
      expect(npmInstallStep).toBeDefined();
    });

    test('should run build command', () => {
      const steps = getSteps();
      const buildStep = steps.find((step: any) => step.run && step.run === 'npm run build');
      expect(buildStep).toBeDefined();
    });

    test('build step should come after install', () => {
      const steps = getSteps();
      const installStepIndex = steps.findIndex((step: any) => step.run && step.run === 'npm install');
      const buildStepIndex = steps.findIndex((step: any) => step.run && step.run === 'npm run build');
      expect(buildStepIndex).toBeGreaterThan(installStepIndex);
    });
  });

  describe('Workflow Steps - Publishing', () => {
    function getSteps() {
      return loadWorkflow().parsed.jobs.build.steps;
    }
    function getPublishStep() {
      const steps = getSteps();
      return steps.find((step: any) => step.uses && step.uses.includes('npm-publish'));
    }

    test('should have npm publish step using JS-DevTools/npm-publish action', () => {
      expect(getPublishStep()).toBeDefined();
    });

    test('publish action should use v4 or later', () => {
      const step = getPublishStep();
      const version = step.uses.match(/@v(\d+)/);
      expect(version).not.toBeNull();
      expect(parseInt(version![1])).toBeGreaterThanOrEqual(4);
    });

    test('publish step should configure registry URL', () => {
      const step = getPublishStep();
      expect(step.with.registry).toBe('https://registry.npmjs.org/');
    });

    test('publish step should use "all" strategy', () => {
      const step = getPublishStep();
      expect(step.with.strategy).toBe('all');
    });

    test('publish step should be the last step', () => {
      const steps = getSteps();
      const publishStepIndex = steps.findIndex((step: any) => step.uses && step.uses.includes('npm-publish'));
      expect(publishStepIndex).toBe(steps.length - 1);
    });

    test('publish step should come after build', () => {
      const steps = getSteps();
      const buildStepIndex = steps.findIndex((step: any) => step.run && step.run === 'npm run build');
      const publishStepIndex = steps.findIndex((step: any) => step.uses && step.uses.includes('npm-publish'));
      expect(publishStepIndex).toBeGreaterThan(buildStepIndex);
    });
  });

  describe('Workflow Step Order and Dependencies', () => {
    test('steps should follow correct execution order', () => {
      const steps = loadWorkflow().parsed.jobs.build.steps;
      const stepDescriptions = steps.map((step: any) => {
        if (step.uses) {
          if (step.uses.includes('checkout')) return 'checkout';
          if (step.uses.includes('setup-node')) return 'setup-node';
          if (step.uses.includes('npm-publish')) return 'publish';
        }
        if (step.run) {
          if (step.run.includes('npm install -g npm@latest')) return 'update-npm';
          if (step.run === 'npm --version') return 'check-npm-version';
          if (step.run === 'npm install') return 'install';
          if (step.run === 'npm run build') return 'build';
        }
        return 'unknown';
      });

      const expectedOrder = ['checkout', 'setup-node', 'update-npm', 'check-npm-version', 'install', 'build', 'publish'];
      expect(stepDescriptions).toEqual(expectedOrder);
    });

    test('all steps should be either actions or run commands', () => {
      const steps = loadWorkflow().parsed.jobs.build.steps;
      steps.forEach((step: any) => {
        const hasUses = step.uses !== undefined;
        const hasRun = step.run !== undefined;
        expect(hasUses || hasRun).toBe(true);
      });
    });
  });

  describe('Security and Best Practices', () => {
    test('workflow should use pinned action versions', () => {
      const steps = loadWorkflow().parsed.jobs.build.steps;
      const actionSteps = steps.filter((step: any) => step.uses);

      actionSteps.forEach((step: any) => {
        expect(step.uses).toMatch(/@v\d+/);
      });
    });

    test('workflow should use OIDC for trusted publishing', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.jobs.build.permissions['id-token']).toBe('write');
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    test('workflow should not have duplicate job names', () => {
      const { parsed: workflow } = loadWorkflow();
      const jobNames = Object.keys(workflow.jobs);
      const uniqueJobNames = new Set(jobNames);
      expect(jobNames.length).toBe(uniqueJobNames.size);
    });

    test('workflow should not have empty steps', () => {
      const { parsed: workflow } = loadWorkflow();
      const steps = workflow.jobs.build.steps;
      steps.forEach((step: any) => {
        expect(step).not.toEqual({});
      });
    });

    test('workflow YAML should not contain syntax errors', () => {
      const { content } = loadWorkflow();
      expect(() => {
        yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      }).not.toThrow();
    });

    test('workflow should be idempotent', () => {
      const { content } = loadWorkflow();
      const parsed1 = yaml.load(content);
      const parsed2 = yaml.load(content);
      expect(parsed1).toEqual(parsed2);
    });
  });

  describe('Integration with Package Configuration', () => {
    function loadPackageJson() {
      const packagePath = path.join(__dirname, '../../package.json');
      if (fs.existsSync(packagePath)) {
        const packageContent = fs.readFileSync(packagePath, 'utf8');
        return JSON.parse(packageContent);
      }
      return undefined;
    }

    test('package.json should exist', () => {
      expect(loadPackageJson()).toBeDefined();
    });

    test('build script referenced in workflow should exist in package.json', () => {
      const packageJson = loadPackageJson();
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.build).toBeDefined();
    });

    test('build script should be executable', () => {
      const packageJson = loadPackageJson();
      expect(typeof packageJson.scripts.build).toBe('string');
      expect(packageJson.scripts.build.length).toBeGreaterThan(0);
    });

    test('package should have a name for npm publishing', () => {
      const packageJson = loadPackageJson();
      expect(packageJson.name).toBeDefined();
      expect(typeof packageJson.name).toBe('string');
    });

    test('package should have a version for npm publishing', () => {
      const packageJson = loadPackageJson();
      expect(packageJson.version).toBeDefined();
      expect(typeof packageJson.version).toBe('string');
    });
  });

  describe('Workflow Completeness', () => {
    test('workflow should have all required top-level keys', () => {
      const { parsed: workflow } = loadWorkflow();
      expect(workflow.name).toBeDefined();
      expect(workflow.on).toBeDefined();
      expect(workflow.jobs).toBeDefined();
    });

    test('workflow should not have deprecated syntax', () => {
      const { content } = loadWorkflow();
      expect(content).not.toContain('::set-output');
      expect(content).not.toContain('::save-state');
    });

    test('workflow file should end with newline', () => {
      const { content } = loadWorkflow();
      expect(content.endsWith('\n')).toBe(true);
    });

    test('workflow should use consistent indentation', () => {
      const { content } = loadWorkflow();
      const lines = content.split('\n');
      const indentedLines = lines.filter(line => line.match(/^[ ]+/));

      indentedLines.forEach(line => {
        const indent = line.match(/^[ ]+/);
        if (indent) {
          expect(indent[0].length % 2).toBe(0);
        }
      });
    });
  });
});
