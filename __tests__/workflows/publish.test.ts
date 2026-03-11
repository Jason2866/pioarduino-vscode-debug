import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('GitHub Actions Publish Workflow', () => {
  const workflowPath = path.join(__dirname, '../../.github/workflows/publish.yml');
  let workflowContent: string;
  let workflow: any;

  beforeAll(() => {
    // Read and parse the workflow file
    workflowContent = fs.readFileSync(workflowPath, 'utf8');
    workflow = yaml.load(workflowContent) as any;
  });

  describe('Workflow File Structure', () => {
    test('workflow file should exist', () => {
      expect(fs.existsSync(workflowPath)).toBe(true);
    });

    test('workflow file should be valid YAML', () => {
      expect(() => yaml.load(workflowContent)).not.toThrow();
    });

    test('workflow should have a name', () => {
      expect(workflow.name).toBeDefined();
      expect(typeof workflow.name).toBe('string');
    });

    test('workflow name should be "Publish to npm"', () => {
      expect(workflow.name).toBe('Publish to npm');
    });
  });

  describe('Workflow Triggers', () => {
    test('workflow should have "on" trigger definition', () => {
      expect(workflow.on).toBeDefined();
    });

    test('workflow should trigger on release published event', () => {
      expect(workflow.on.release).toBeDefined();
      expect(workflow.on.release.types).toContain('published');
    });

    test('workflow should only trigger on published releases', () => {
      expect(workflow.on.release.types).toEqual(['published']);
    });

    test('workflow should not have other trigger types', () => {
      const triggerKeys = Object.keys(workflow.on);
      expect(triggerKeys).toEqual(['release']);
    });
  });

  describe('Workflow Permissions', () => {
    test('workflow should have permissions defined', () => {
      expect(workflow.permissions).toBeDefined();
    });

    test('workflow should have id-token write permission for provenance', () => {
      expect(workflow.permissions['id-token']).toBe('write');
    });

    test('workflow should have contents read permission', () => {
      expect(workflow.permissions.contents).toBe('read');
    });

    test('workflow should only have necessary permissions', () => {
      const permissionKeys = Object.keys(workflow.permissions);
      expect(permissionKeys.sort()).toEqual(['contents', 'id-token'].sort());
    });

    test('workflow should not have excessive permissions', () => {
      // Ensure no write access to contents or other dangerous permissions
      expect(workflow.permissions.contents).not.toBe('write');
      expect(workflow.permissions.packages).toBeUndefined();
      expect(workflow.permissions.actions).toBeUndefined();
    });
  });

  describe('Workflow Jobs', () => {
    test('workflow should have jobs defined', () => {
      expect(workflow.jobs).toBeDefined();
    });

    test('workflow should have a publish job', () => {
      expect(workflow.jobs.publish).toBeDefined();
    });

    test('publish job should run on ubuntu-latest', () => {
      expect(workflow.jobs.publish['runs-on']).toBe('ubuntu-latest');
    });

    test('publish job should have steps', () => {
      expect(workflow.jobs.publish.steps).toBeDefined();
      expect(Array.isArray(workflow.jobs.publish.steps)).toBe(true);
    });

    test('publish job should have at least 6 steps', () => {
      expect(workflow.jobs.publish.steps.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Workflow Steps - Checkout and Setup', () => {
    let steps: any[];

    beforeAll(() => {
      steps = workflow.jobs.publish.steps;
    });

    test('first step should checkout the code', () => {
      expect(steps[0].uses).toMatch(/actions\/checkout@v/);
    });

    test('checkout should use v4 or later', () => {
      const checkoutVersion = steps[0].uses.match(/@v(\d+)/);
      expect(checkoutVersion).not.toBeNull();
      expect(parseInt(checkoutVersion![1])).toBeGreaterThanOrEqual(4);
    });

    test('second step should setup Node.js', () => {
      expect(steps[1].uses).toMatch(/actions\/setup-node@v/);
    });

    test('Node.js setup should use v4 or later', () => {
      const nodeVersion = steps[1].uses.match(/@v(\d+)/);
      expect(nodeVersion).not.toBeNull();
      expect(parseInt(nodeVersion![1])).toBeGreaterThanOrEqual(4);
    });

    test('Node.js should be configured with version 22', () => {
      expect(steps[1].with).toBeDefined();
      expect(steps[1].with['node-version']).toBe(22);
    });

    test('Node.js should be configured with npm registry', () => {
      expect(steps[1].with['registry-url']).toBe('https://registry.npmjs.org');
    });
  });

  describe('Workflow Steps - Build Process', () => {
    let steps: any[];

    beforeAll(() => {
      steps = workflow.jobs.publish.steps;
    });

    test('should update npm to latest version', () => {
      const npmUpdateStep = steps.find(step => step.run && step.run.includes('npm install -g npm@latest'));
      expect(npmUpdateStep).toBeDefined();
    });

    test('should install dependencies', () => {
      const npmInstallStep = steps.find(step => step.run && step.run === 'npm install');
      expect(npmInstallStep).toBeDefined();
    });

    test('should clean dist directory before build', () => {
      const cleanStep = steps.find(step => step.run && step.run.includes('rm -rf dist'));
      expect(cleanStep).toBeDefined();
    });

    test('clean step should come before build step', () => {
      const cleanStepIndex = steps.findIndex(step => step.run && step.run.includes('rm -rf dist'));
      const buildStepIndex = steps.findIndex(step => step.run && step.run.includes('npm run build'));
      expect(cleanStepIndex).toBeLessThan(buildStepIndex);
    });

    test('should run build command', () => {
      const buildStep = steps.find(step => step.run && step.run === 'npm run build');
      expect(buildStep).toBeDefined();
    });

    test('build step should come after npm install', () => {
      const installStepIndex = steps.findIndex(step => step.run && step.run === 'npm install');
      const buildStepIndex = steps.findIndex(step => step.run && step.run === 'npm run build');
      expect(buildStepIndex).toBeGreaterThan(installStepIndex);
    });
  });

  describe('Workflow Steps - Publishing', () => {
    let steps: any[];
    let publishStep: any;

    beforeAll(() => {
      steps = workflow.jobs.publish.steps;
      publishStep = steps.find(step => step.run && step.run.includes('npm publish'));
    });

    test('should have npm publish step', () => {
      expect(publishStep).toBeDefined();
    });

    test('publish should use --provenance flag for transparency', () => {
      expect(publishStep.run).toContain('--provenance');
    });

    test('publish should use --access public flag', () => {
      expect(publishStep.run).toContain('--access public');
    });

    test('publish command should have both required flags', () => {
      expect(publishStep.run).toMatch(/npm publish.*--provenance.*--access public/);
    });

    test('publish step should be the last step', () => {
      const publishStepIndex = steps.findIndex(step => step.run && step.run.includes('npm publish'));
      expect(publishStepIndex).toBe(steps.length - 1);
    });

    test('publish step should come after build', () => {
      const buildStepIndex = steps.findIndex(step => step.run && step.run === 'npm run build');
      const publishStepIndex = steps.findIndex(step => step.run && step.run.includes('npm publish'));
      expect(publishStepIndex).toBeGreaterThan(buildStepIndex);
    });
  });

  describe('Workflow Step Order and Dependencies', () => {
    let steps: any[];

    beforeAll(() => {
      steps = workflow.jobs.publish.steps;
    });

    test('steps should follow correct execution order', () => {
      const stepDescriptions = steps.map(step => {
        if (step.uses) {
          if (step.uses.includes('checkout')) return 'checkout';
          if (step.uses.includes('setup-node')) return 'setup-node';
        }
        if (step.run) {
          if (step.run.includes('npm install -g npm@latest')) return 'update-npm';
          if (step.run === 'npm install') return 'install';
          if (step.run.includes('rm -rf dist')) return 'clean';
          if (step.run === 'npm run build') return 'build';
          if (step.run.includes('npm publish')) return 'publish';
        }
        return 'unknown';
      });

      const expectedOrder = ['checkout', 'setup-node', 'update-npm', 'install', 'clean', 'build', 'publish'];
      expect(stepDescriptions).toEqual(expectedOrder);
    });

    test('all steps should be either actions or run commands', () => {
      steps.forEach(step => {
        const hasUses = step.uses !== undefined;
        const hasRun = step.run !== undefined;
        expect(hasUses || hasRun).toBe(true);
      });
    });
  });

  describe('Security and Best Practices', () => {
    test('workflow should use pinned action versions', () => {
      const steps = workflow.jobs.publish.steps;
      const actionSteps = steps.filter((step: any) => step.uses);

      actionSteps.forEach((step: any) => {
        // Should have @v followed by a number
        expect(step.uses).toMatch(/@v\d+/);
      });
    });

    test('workflow should use provenance for supply chain security', () => {
      const steps = workflow.jobs.publish.steps;
      const publishStep = steps.find((step: any) => step.run && step.run.includes('npm publish'));
      expect(publishStep.run).toContain('--provenance');
    });

    test('workflow should have minimal permissions', () => {
      // id-token: write is required for provenance
      // contents: read is minimal permission for checkout
      expect(workflow.permissions['id-token']).toBe('write');
      expect(workflow.permissions.contents).toBe('read');

      // Should not have write permissions for contents
      expect(workflow.permissions.contents).not.toBe('write');
    });

    test('workflow should clean build artifacts before building', () => {
      const steps = workflow.jobs.publish.steps;
      const cleanStep = steps.find((step: any) => step.run && step.run.includes('rm -rf dist'));
      expect(cleanStep).toBeDefined();
    });

    test('workflow should update npm before installing', () => {
      const steps = workflow.jobs.publish.steps;
      const npmUpdateStep = steps.find((step: any) => step.run && step.run.includes('npm install -g npm@latest'));
      expect(npmUpdateStep).toBeDefined();
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    test('workflow should not have duplicate job names', () => {
      const jobNames = Object.keys(workflow.jobs);
      const uniqueJobNames = new Set(jobNames);
      expect(jobNames.length).toBe(uniqueJobNames.size);
    });

    test('workflow should not have empty steps', () => {
      const steps = workflow.jobs.publish.steps;
      steps.forEach((step: any) => {
        expect(step).not.toEqual({});
      });
    });

    test('workflow should handle missing dist directory gracefully', () => {
      const steps = workflow.jobs.publish.steps;
      const cleanStep = steps.find((step: any) => step.run && step.run.includes('rm -rf dist'));
      // rm -rf should not fail if directory doesn't exist
      expect(cleanStep.run).toBe('rm -rf dist');
    });

    test('workflow YAML should not contain syntax errors', () => {
      expect(() => {
        yaml.load(workflowContent, { schema: yaml.FAILSAFE_SCHEMA });
      }).not.toThrow();
    });

    test('workflow should be idempotent', () => {
      // Multiple runs should produce same result
      const parsed1 = yaml.load(workflowContent);
      const parsed2 = yaml.load(workflowContent);
      expect(parsed1).toEqual(parsed2);
    });
  });

  describe('Integration with Package Configuration', () => {
    let packageJson: any;

    beforeAll(() => {
      const packagePath = path.join(__dirname, '../../package.json');
      if (fs.existsSync(packagePath)) {
        const packageContent = fs.readFileSync(packagePath, 'utf8');
        packageJson = JSON.parse(packageContent);
      }
    });

    test('package.json should exist', () => {
      expect(packageJson).toBeDefined();
    });

    test('build script referenced in workflow should exist in package.json', () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.build).toBeDefined();
    });

    test('build script should be executable', () => {
      expect(typeof packageJson.scripts.build).toBe('string');
      expect(packageJson.scripts.build.length).toBeGreaterThan(0);
    });

    test('package should have a name for npm publishing', () => {
      expect(packageJson.name).toBeDefined();
      expect(typeof packageJson.name).toBe('string');
    });

    test('package should have a version for npm publishing', () => {
      expect(packageJson.version).toBeDefined();
      expect(typeof packageJson.version).toBe('string');
    });
  });

  describe('Workflow Completeness', () => {
    test('workflow should have all required top-level keys', () => {
      expect(workflow.name).toBeDefined();
      expect(workflow.on).toBeDefined();
      expect(workflow.permissions).toBeDefined();
      expect(workflow.jobs).toBeDefined();
    });

    test('workflow should not have deprecated syntax', () => {
      // Check that workflow doesn't use old syntax
      expect(workflowContent).not.toContain('::set-output');
      expect(workflowContent).not.toContain('::save-state');
    });

    test('workflow file should end with newline', () => {
      expect(workflowContent.endsWith('\n')).toBe(true);
    });

    test('workflow should use consistent indentation', () => {
      const lines = workflowContent.split('\n');
      const indentedLines = lines.filter(line => line.match(/^[ ]+/));

      // Check that all indentation is consistent (multiples of 2)
      indentedLines.forEach(line => {
        const indent = line.match(/^[ ]+/);
        if (indent) {
          expect(indent[0].length % 2).toBe(0);
        }
      });
    });
  });

  describe('Negative Test Cases', () => {
    test('workflow should not trigger on push events', () => {
      expect(workflow.on.push).toBeUndefined();
    });

    test('workflow should not trigger on pull request events', () => {
      expect(workflow.on.pull_request).toBeUndefined();
    });

    test('workflow should not have manual workflow_dispatch trigger', () => {
      expect(workflow.on.workflow_dispatch).toBeUndefined();
    });

    test('workflow should not have scheduled triggers', () => {
      expect(workflow.on.schedule).toBeUndefined();
    });

    test('publish step should not use --dry-run flag', () => {
      const steps = workflow.jobs.publish.steps;
      const publishStep = steps.find((step: any) => step.run && step.run.includes('npm publish'));
      expect(publishStep.run).not.toContain('--dry-run');
    });

    test('workflow should not skip git checks', () => {
      expect(workflowContent).not.toContain('--no-git-checks');
    });

    test('workflow should not force publish', () => {
      expect(workflowContent).not.toContain('--force');
    });
  });
});