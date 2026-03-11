import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

describe('Publish Workflow (.github/workflows/publish.yml)', () => {
  let workflowContent: any;
  const workflowPath = path.join(__dirname, '../.github/workflows/publish.yml');

  beforeAll(() => {
    const fileContent = fs.readFileSync(workflowPath, 'utf8');
    workflowContent = yaml.load(fileContent);
  });

  describe('Basic Structure', () => {
    test('should have a valid YAML structure', () => {
      expect(workflowContent).toBeDefined();
      expect(typeof workflowContent).toBe('object');
    });

    test('should have a descriptive name', () => {
      expect(workflowContent.name).toBeDefined();
      expect(workflowContent.name).toBe('Publish to npm');
    });

    test('should have proper workflow structure with on, permissions, and jobs', () => {
      expect(workflowContent).toHaveProperty('on');
      expect(workflowContent).toHaveProperty('permissions');
      expect(workflowContent).toHaveProperty('jobs');
    });
  });

  describe('Workflow Triggers', () => {
    test('should trigger on release published event', () => {
      expect(workflowContent.on).toBeDefined();
      expect(workflowContent.on.release).toBeDefined();
      expect(workflowContent.on.release.types).toContain('published');
    });

    test('should only trigger on published release type', () => {
      expect(workflowContent.on.release.types).toHaveLength(1);
      expect(workflowContent.on.release.types[0]).toBe('published');
    });

    test('should not have manual workflow_dispatch trigger', () => {
      expect(workflowContent.on.workflow_dispatch).toBeUndefined();
    });
  });

  describe('Permissions', () => {
    test('should have id-token write permission for provenance', () => {
      expect(workflowContent.permissions).toBeDefined();
      expect(workflowContent.permissions['id-token']).toBe('write');
    });

    test('should have contents read permission', () => {
      expect(workflowContent.permissions.contents).toBe('read');
    });

    test('should only have necessary permissions (id-token and contents)', () => {
      const permissionKeys = Object.keys(workflowContent.permissions);
      expect(permissionKeys).toHaveLength(2);
      expect(permissionKeys).toContain('id-token');
      expect(permissionKeys).toContain('contents');
    });

    test('should not have overly permissive write-all permissions', () => {
      expect(workflowContent.permissions['write-all']).toBeUndefined();
      expect(workflowContent.permissions).not.toBe('write-all');
    });
  });

  describe('Jobs Configuration', () => {
    test('should have a publish job', () => {
      expect(workflowContent.jobs).toBeDefined();
      expect(workflowContent.jobs.publish).toBeDefined();
    });

    test('should run on ubuntu-latest', () => {
      expect(workflowContent.jobs.publish['runs-on']).toBe('ubuntu-latest');
    });

    test('should have steps defined', () => {
      expect(workflowContent.jobs.publish.steps).toBeDefined();
      expect(Array.isArray(workflowContent.jobs.publish.steps)).toBe(true);
      expect(workflowContent.jobs.publish.steps.length).toBeGreaterThan(0);
    });
  });

  describe('Workflow Steps', () => {
    let steps: any[];

    beforeAll(() => {
      steps = workflowContent.jobs.publish.steps;
    });

    test('should have exactly 7 steps', () => {
      expect(steps).toHaveLength(7);
    });

    describe('Step 1: Checkout', () => {
      test('should checkout code using actions/checkout@v4', () => {
        expect(steps[0].uses).toBe('actions/checkout@v4');
      });

      test('should not have any additional parameters', () => {
        expect(steps[0].with).toBeUndefined();
      });
    });

    describe('Step 2: Setup Node', () => {
      test('should setup Node.js using actions/setup-node@v4', () => {
        expect(steps[1].uses).toBe('actions/setup-node@v4');
      });

      test('should configure Node.js version 22', () => {
        expect(steps[1].with).toBeDefined();
        expect(steps[1].with['node-version']).toBe(22);
      });

      test('should configure npm registry URL', () => {
        expect(steps[1].with['registry-url']).toBe('https://registry.npmjs.org');
      });

      test('should use the official npm registry (not a mirror or private registry)', () => {
        expect(steps[1].with['registry-url']).toMatch(/^https:\/\/registry\.npmjs\.org$/);
      });
    });

    describe('Step 3: Update npm', () => {
      test('should update npm to latest version globally', () => {
        expect(steps[2].run).toBe('npm install -g npm@latest');
      });

      test('should use global installation flag', () => {
        expect(steps[2].run).toContain('-g');
      });
    });

    describe('Step 4: Install Dependencies', () => {
      test('should install npm dependencies', () => {
        expect(steps[3].run).toBe('npm install');
      });

      test('should not use npm ci for production builds', () => {
        expect(steps[3].run).not.toContain('npm ci');
      });
    });

    describe('Step 5: Clean dist', () => {
      test('should remove dist directory before build', () => {
        expect(steps[4].run).toBe('rm -rf dist');
      });

      test('should force remove directory recursively', () => {
        expect(steps[4].run).toContain('-rf');
      });
    });

    describe('Step 6: Build', () => {
      test('should run build script', () => {
        expect(steps[5].run).toBe('npm run build');
      });
    });

    describe('Step 7: Publish', () => {
      test('should publish to npm', () => {
        expect(steps[6].run).toContain('npm publish');
      });

      test('should include provenance flag for supply chain security', () => {
        expect(steps[6].run).toContain('--provenance');
      });

      test('should publish with public access', () => {
        expect(steps[6].run).toContain('--access public');
      });

      test('should have complete publish command with all flags', () => {
        expect(steps[6].run).toBe('npm publish --provenance --access public');
      });

      test('should not include dry-run flag', () => {
        expect(steps[6].run).not.toContain('--dry-run');
      });
    });
  });

  describe('Security Best Practices', () => {
    test('should use pinned action versions (not @main or @master)', () => {
      const actionSteps = workflowContent.jobs.publish.steps.filter((step: any) => step.uses);
      actionSteps.forEach((step: any) => {
        expect(step.uses).not.toMatch(/@main$/);
        expect(step.uses).not.toMatch(/@master$/);
      });
    });

    test('should use actions from verified publishers', () => {
      const actionSteps = workflowContent.jobs.publish.steps.filter((step: any) => step.uses);
      actionSteps.forEach((step: any) => {
        // Ensure actions are from actions/* namespace (official GitHub actions)
        expect(step.uses).toMatch(/^actions\//);
      });
    });

    test('should enable provenance for npm package', () => {
      const publishStep = workflowContent.jobs.publish.steps[6];
      expect(publishStep.run).toContain('--provenance');
    });

    test('should have appropriate permissions for provenance', () => {
      // Provenance requires id-token write permission
      expect(workflowContent.permissions['id-token']).toBe('write');
    });

    test('should not expose sensitive tokens in workflow file', () => {
      const workflowString = JSON.stringify(workflowContent);
      expect(workflowString).not.toMatch(/npm_[a-zA-Z0-9_]+/);
      expect(workflowString).not.toMatch(/ghp_[a-zA-Z0-9]+/);
    });
  });

  describe('Build Process Integrity', () => {
    test('should clean build artifacts before building', () => {
      const steps = workflowContent.jobs.publish.steps;
      const cleanStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('rm -rf dist'));
      const buildStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm run build'));

      expect(cleanStepIndex).toBeGreaterThan(-1);
      expect(buildStepIndex).toBeGreaterThan(-1);
      expect(cleanStepIndex).toBeLessThan(buildStepIndex);
    });

    test('should install dependencies before building', () => {
      const steps = workflowContent.jobs.publish.steps;
      const installStepIndex = steps.findIndex((s: any) => s.run === 'npm install');
      const buildStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm run build'));

      expect(installStepIndex).toBeLessThan(buildStepIndex);
    });

    test('should build before publishing', () => {
      const steps = workflowContent.jobs.publish.steps;
      const buildStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm run build'));
      const publishStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm publish'));

      expect(buildStepIndex).toBeLessThan(publishStepIndex);
    });

    test('should update npm before installing dependencies', () => {
      const steps = workflowContent.jobs.publish.steps;
      const updateNpmIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm install -g npm@latest'));
      const installDepsIndex = steps.findIndex((s: any) => s.run === 'npm install');

      expect(updateNpmIndex).toBeLessThan(installDepsIndex);
    });
  });

  describe('Node.js Configuration', () => {
    test('should use Node.js version 22 (LTS or current)', () => {
      const setupNodeStep = workflowContent.jobs.publish.steps[1];
      expect(setupNodeStep.with['node-version']).toBeGreaterThanOrEqual(18);
    });

    test('should use a specific major version (not ranges)', () => {
      const setupNodeStep = workflowContent.jobs.publish.steps[1];
      const nodeVersion = setupNodeStep.with['node-version'];
      expect(typeof nodeVersion).toBe('number');
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    test('should not have conditional steps that could skip critical operations', () => {
      const steps = workflowContent.jobs.publish.steps;
      const buildStep = steps.find((s: any) => s.run && s.run.includes('npm run build'));
      const publishStep = steps.find((s: any) => s.run && s.run.includes('npm publish'));

      expect(buildStep.if).toBeUndefined();
      expect(publishStep.if).toBeUndefined();
    });

    test('should not have environment-specific conditions that could cause failures', () => {
      const publishJob = workflowContent.jobs.publish;
      expect(publishJob.if).toBeUndefined();
    });

    test('should use consistent command format across all run steps', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        expect(typeof step.run).toBe('string');
        expect(step.run.trim().length).toBeGreaterThan(0);
      });
    });
  });

  describe('Regression Tests', () => {
    test('should maintain workflow file format and indentation', () => {
      const fileContent = fs.readFileSync(workflowPath, 'utf8');
      expect(fileContent).toContain('name: Publish to npm');
      expect(fileContent).toMatch(/^on:/m);
      expect(fileContent).toMatch(/^permissions:/m);
      expect(fileContent).toMatch(/^jobs:/m);
    });

    test('should not have trailing whitespace or extra blank lines', () => {
      const fileContent = fs.readFileSync(workflowPath, 'utf8');
      const lines = fileContent.split('\n');

      lines.forEach((line, index) => {
        if (line.trim().length > 0) {
          expect(line).not.toMatch(/\s+$/);
        }
      });
    });

    test('workflow should be parseable without errors', () => {
      const fileContent = fs.readFileSync(workflowPath, 'utf8');
      expect(() => yaml.load(fileContent)).not.toThrow();
    });
  });

  describe('Boundary Conditions', () => {
    test('should handle workflow with minimum required fields', () => {
      expect(workflowContent.name).toBeTruthy();
      expect(workflowContent.on).toBeTruthy();
      expect(workflowContent.jobs).toBeTruthy();
    });

    test('should not have excessively long step commands', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        // Commands should be reasonably short (less than 200 chars)
        expect(step.run.length).toBeLessThan(200);
      });
    });

    test('should use standard shell commands available in ubuntu-latest', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        // Should only use npm and rm commands (available in ubuntu-latest)
        const command = step.run.split(' ')[0];
        expect(['npm', 'rm']).toContain(command);
      });
    });
  });

  describe('Negative Test Cases', () => {
    test('should not use deprecated npm commands', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        expect(step.run).not.toContain('npm cache clean');
        expect(step.run).not.toContain('npm dedupe');
      });
    });

    test('should not have steps with empty run commands', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        expect(step.run.trim()).not.toBe('');
      });
    });

    test('should not include test or lint steps in publish workflow', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        expect(step.run).not.toContain('npm test');
        expect(step.run).not.toContain('npm run test');
        expect(step.run).not.toContain('npm run lint');
      });
    });

    test('should not have multiple publish steps', () => {
      const steps = workflowContent.jobs.publish.steps;
      const publishSteps = steps.filter((s: any) => s.run && s.run.includes('npm publish'));

      expect(publishSteps).toHaveLength(1);
    });
  });

  describe('Future-Proofing', () => {
    test('should use v4 actions (not outdated v1, v2, or v3)', () => {
      const actionSteps = workflowContent.jobs.publish.steps.filter((step: any) => step.uses);
      actionSteps.forEach((step: any) => {
        expect(step.uses).toMatch(/@v4$/);
      });
    });

    test('should not hardcode paths that might change', () => {
      const steps = workflowContent.jobs.publish.steps;
      const runSteps = steps.filter((s: any) => s.run);

      runSteps.forEach((step: any) => {
        // Should use relative paths, not absolute paths
        expect(step.run).not.toMatch(/\/home\//);
        expect(step.run).not.toMatch(/\/usr\//);
      });
    });
  });
});