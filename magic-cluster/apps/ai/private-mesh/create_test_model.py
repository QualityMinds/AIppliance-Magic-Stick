"""Tiny deterministic Qwen2 fixture for real CPU-vLLM protocol acceptance.

Random weights are deliberately not a quality benchmark or production model.
Generated only in the isolated test Job; no model download or GPU is required.
"""
from pathlib import Path
import torch
from tokenizers.pre_tokenizers import ByteLevel
from transformers import AutoTokenizer, Qwen2Tokenizer, Qwen2Config, Qwen2ForCausalLM


def main():
    directory = Path('/test/vllm-model')
    directory.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(42)
    tokens = ['[PAD]', '[BOS]', '[EOS]', '[UNK]'] + sorted(ByteLevel.alphabet())
    vocabulary = {value: index for index, value in enumerate(tokens)}
    model = Qwen2ForCausalLM(Qwen2Config(vocab_size=len(vocabulary), hidden_size=128,
        intermediate_size=256, num_hidden_layers=2, num_attention_heads=4,
        num_key_value_heads=2, max_position_embeddings=2048, bos_token_id=1,
        eos_token_id=2, pad_token_id=0, tie_word_embeddings=True))
    model.save_pretrained(directory, safe_serialization=True)
    # Use the model's native tokenizer: Transformers 5 reconstructs Qwen2's
    # tokenizer on AutoTokenizer reload, so a generic WordLevel wrapper is not
    # a valid round-trip fixture even if its initial encoding works.
    tokenizer = Qwen2Tokenizer(vocab=vocabulary, merges=[], model_max_length=2048,
        unk_token='[UNK]', pad_token='[PAD]', bos_token='[BOS]', eos_token='[EOS]')
    tokenizer.chat_template = "hello {% for message in messages %}{{ message['role'] + ' ' + message['content'] + ' ' }}{% endfor %}{% if add_generation_prompt %}assistant {% endif %}"
    tokenizer.save_pretrained(directory)
    assert AutoTokenizer.from_pretrained(directory).encode('hello'), 'Test tokenizer failed its save/load round trip'
    print('Created isolated synthetic Qwen2 weights for real vLLM protocol testing.')


if __name__ == '__main__':
    main()
