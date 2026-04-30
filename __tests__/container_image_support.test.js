const core = require('@actions/core');
const originalValidations = require('../validations');

jest.mock('@actions/core');
jest.mock('@aws-sdk/client-lambda', () => {
  const original = jest.requireActual('@aws-sdk/client-lambda');
  return {
    ...original,
    CreateFunctionCommand: jest.fn().mockImplementation((params) => ({
      ...params,
      type: 'CreateFunctionCommand'
    })),
    UpdateFunctionCodeCommand: jest.fn().mockImplementation((params) => ({
      ...params,
      type: 'UpdateFunctionCodeCommand'
    })),
    GetFunctionConfigurationCommand: jest.fn().mockImplementation((params) => ({
      ...params,
      type: 'GetFunctionConfigurationCommand'
    })),
    LambdaClient: jest.fn().mockImplementation(() => ({
      send: jest.fn()
    })),
    waitUntilFunctionUpdated: jest.fn().mockResolvedValue({})
  };
});

describe('Container Image Support Tests', () => {
  let originalEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env;
    process.env = { ...originalEnv };
    process.env.GITHUB_SHA = 'abc123';

    // Default mock implementations
    core.getInput.mockImplementation((name) => {
      const inputs = {
        'function-name': 'test-function',
        'package-type': 'Image',
        'image-uri': '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest',
        'region': 'us-east-1'
      };
      return inputs[name] || '';
    });

    core.getBooleanInput.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Package Type Validation', () => {
    test('should accept Image package type with image-uri', () => {
      const result = originalValidations.validateAllInputs();
      expect(result.valid).toBe(true);
      expect(result.packageType).toBe('Image');
      expect(result.imageUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest');
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    test('should fail when Image package type is used without image-uri', () => {
      core.getInput.mockImplementation((name) => {
        const inputs = {
          'function-name': 'test-function',
          'package-type': 'Image',
          'region': 'us-east-1'
        };
        return inputs[name] || '';
      });
      
      const result = originalValidations.validateAllInputs();
      expect(result.valid).toBe(false);
      expect(core.setFailed).toHaveBeenCalledWith('image-uri must be provided when package-type is "Image"');
    });


    test('should fail when Zip package type is used without code-artifacts-dir', () => {
      core.getInput.mockImplementation((name) => {
        const inputs = {
          'function-name': 'test-function',
          'package-type': 'Zip',
          'region': 'us-east-1'
        };
        return inputs[name] || '';
      });
      
      const result = originalValidations.validateAllInputs();
      expect(result.valid).toBe(false);
      expect(core.setFailed).toHaveBeenCalledWith('code-artifacts-dir must be provided when package-type is "Zip"');
    });

    test('should reject invalid package type', () => {
      core.getInput.mockImplementation((name) => {
        const inputs = {
          'function-name': 'test-function',
          'package-type': 'InvalidType',
          'region': 'us-east-1'
        };
        return inputs[name] || '';
      });
      
      const result = originalValidations.validateAllInputs();
      expect(result.valid).toBe(false);
      expect(core.setFailed).toHaveBeenCalledWith('Package type must be either \'Zip\' or \'Image\', got: InvalidType');
    });

    test('should default to Zip package type when not specified', () => {
      core.getInput.mockImplementation((name) => {
        const inputs = {
          'function-name': 'test-function',
          'code-artifacts-dir': './artifacts',
          'region': 'us-east-1'
        };
        return inputs[name] || '';
      });

      const result = originalValidations.validateAllInputs();
      expect(result.valid).toBe(true);
      expect(result.packageType).toBe('Zip');
    });
  });

  // Regression tests for issue #70: v1.1.1 broke Image package type by
  // unconditionally calling packageCodeArtifacts and stripping packageType
  // from createFunction / updateFunctionCode.
  describe('Image package type wiring (regression for #70)', () => {
    const { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand } = require('@aws-sdk/client-lambda');
    const index = require('../index');

    test('createFunction sends ImageUri and PackageType=Image, omits Runtime/Handler/Layers/ZipFile', async () => {
      // Respond to both CreateFunctionCommand (the assertion target) and the
      // GetFunctionConfigurationCommand polled by waitForFunctionActive.
      const mockSend = jest.fn().mockImplementation((cmd) => {
        if (cmd && cmd.type === 'GetFunctionConfigurationCommand') {
          return Promise.resolve({ State: 'Active' });
        }
        return Promise.resolve({
          FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
          Version: '1'
        });
      });
      LambdaClient.mockImplementation(() => ({ send: mockSend }));

      const client = new LambdaClient();
      const inputs = {
        functionName: 'test-function',
        packageType: 'Image',
        imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest',
        region: 'us-east-1',
        role: 'arn:aws:iam::123456789012:role/test-role',
        runtime: 'nodejs20.x',     // must be ignored for Image
        handler: 'index.handler',  // must be ignored for Image
        layers: ['arn:aws:lambda:us-east-1:123:layer:l1:1'], // must be ignored for Image
        parsedLayers: ['arn:aws:lambda:us-east-1:123:layer:l1:1'],
        parsedEnvironment: {}
      };

      await index.createFunction(client, inputs, false);

      const createCall = mockSend.mock.calls.find(
        ([c]) => c && c.type === 'CreateFunctionCommand'
      );
      expect(createCall).toBeDefined();
      const sentInput = createCall[0];
      expect(sentInput.PackageType).toBe('Image');
      expect(sentInput.Code).toEqual({
        ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
      });
      expect(sentInput.Code.ZipFile).toBeUndefined();
      expect(sentInput.Runtime).toBeUndefined();
      expect(sentInput.Handler).toBeUndefined();
      expect(sentInput.Layers).toBeUndefined();
    });

    test('updateFunctionCode sends ImageUri instead of ZipFile when packageType=Image', async () => {
      const mockSend = jest.fn().mockResolvedValue({
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
        Version: '2'
      });
      LambdaClient.mockImplementation(() => ({ send: mockSend }));

      const client = new LambdaClient();
      const params = {
        functionName: 'test-function',
        packageType: 'Image',
        imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest',
        finalZipPath: null,
        useS3Method: false,
        architectures: 'x86_64',
        publish: false,
        dryRun: false,
        region: 'us-east-1'
      };

      await index.updateFunctionCode(client, params);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentInput = mockSend.mock.calls[0][0];
      expect(sentInput.type).toBe('UpdateFunctionCodeCommand');
      expect(sentInput.ImageUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest');
      expect(sentInput.ZipFile).toBeUndefined();
      expect(sentInput.S3Bucket).toBeUndefined();
      expect(sentInput.S3Key).toBeUndefined();
    });
  });

});