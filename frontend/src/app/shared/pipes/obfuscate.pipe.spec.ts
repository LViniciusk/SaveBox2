import { ObfuscatePipe } from './obfuscate.pipe';

describe('ObfuscatePipe', () => {
  let pipe: ObfuscatePipe;

  beforeEach(() => {
    pipe = new ObfuscatePipe();
  });

  it('should create an instance', () => {
    expect(pipe).toBeTruthy();
  });

  describe('when unlocked', () => {
    it('should return the original value unmodified', () => {
      const value = 'very_long_file_name_that_should_not_be_truncated.txt';
      const result = pipe.transform(value, false);
      expect(result).toBe(value);
    });
  });

  describe('when locked', () => {
    it('should truncate the value if it exceeds 15 characters and append ellipsis', () => {
      const value = 'very_long_file_name.txt';
      const result = pipe.transform(value, true);
      expect(result).toBe('very_long_file_...');
      expect(result.length).toBe(18); // 15 + 3 (...)
    });

    it('should not truncate the value if it is 15 characters or less', () => {
      const value = 'short_name.txt'; // 14 chars
      const result = pipe.transform(value, true);
      expect(result).toBe(value);
    });
    
    it('should not truncate exactly 15 characters', () => {
      const value = '123456789012345'; // 15 chars
      const result = pipe.transform(value, true);
      expect(result).toBe(value);
    });
  });
});
