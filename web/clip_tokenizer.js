/**
 * CLIP tokenizer used by Stable Diffusion 1.5 / XL text encoders.
 *
 * The original mithril-security tokenizers-wasm package panics
 * (`RuntimeError: unreachable`) on current Hugging Face tokenizer.json
 * files because Tokenizer::from_str(...).unwrap() cannot load newer
 * Split/Sequence pre-tokenizer specs.
 */

function bytesToUnicode() {
  const bs = [];
  const cs = [];
  for (let i = "!".charCodeAt(0); i <= "~".charCodeAt(0); ++i) {
    bs.push(i);
  }
  for (let i = "¡".charCodeAt(0); i <= "¬".charCodeAt(0); ++i) {
    bs.push(i);
  }
  for (let i = "®".charCodeAt(0); i <= "ÿ".charCodeAt(0); ++i) {
    bs.push(i);
  }
  cs.push(...bs);
  let n = 0;
  for (let b = 0; b < 256; ++b) {
    if (bs.indexOf(b) === -1) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const encoder = Object.create(null);
  for (let i = 0; i < bs.length; ++i) {
    encoder[bs[i]] = String.fromCharCode(cs[i]);
  }
  return encoder;
}

function getPairs(word) {
  const pairs = [];
  for (let i = 0; i < word.length - 1; ++i) {
    pairs.push([word[i], word[i + 1]]);
  }
  return pairs;
}

export class CLIPTokenizer {
  static fromJson(jsonText) {
    return new CLIPTokenizer(JSON.parse(jsonText));
  }

  constructor(spec) {
    if (!spec || !spec.model || !spec.model.vocab || !spec.model.merges) {
      throw Error("tokenizer.json is missing a BPE vocab/merges model");
    }

    this.vocab = spec.model.vocab;
    this.unkId = this.vocab[spec.model.unk_token] ?? this.vocab["<|endoftext|>"];
    this.bosId = this.vocab["<|startoftext|>"];
    this.eosId = this.vocab["<|endoftext|>"];
    if (this.bosId === undefined || this.eosId === undefined) {
      throw Error("CLIP tokenizer.json is missing <|startoftext|> / <|endoftext|>");
    }

    this.bpeRanks = new Map();
    spec.model.merges.forEach((merge, index) => {
      const parts = Array.isArray(merge) ? merge : String(merge).split(" ");
      this.bpeRanks.set(parts[0] + "\0" + parts[1], index);
    });
    this.byteEncoder = bytesToUnicode();
    this.cache = new Map();
    this.pat = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;
    this.encoder = new TextEncoder();
  }

  normalize(text) {
    return String(text).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  }

  bpe(token) {
    if (this.cache.has(token)) {
      return this.cache.get(token);
    }
    if (token.length === 0) {
      return token;
    }

    let word = token.split("");
    word[word.length - 1] = word[word.length - 1] + "</w>";
    let pairs = getPairs(word);
    if (pairs.length === 0) {
      const result = token + "</w>";
      this.cache.set(token, result);
      return result;
    }

    while (true) {
      let minRank = Infinity;
      let bigram = null;
      for (let i = 0; i < pairs.length; ++i) {
        const rank = this.bpeRanks.get(pairs[i][0] + "\0" + pairs[i][1]);
        if (rank !== undefined && rank < minRank) {
          minRank = rank;
          bigram = pairs[i];
        }
      }
      if (bigram === null) {
        break;
      }

      const first = bigram[0];
      const second = bigram[1];
      const newWord = [];
      let i = 0;
      while (i < word.length) {
        let j = -1;
        for (let k = i; k < word.length; ++k) {
          if (word[k] === first) {
            j = k;
            break;
          }
        }
        if (j === -1) {
          newWord.push.apply(newWord, word.slice(i));
          break;
        }
        newWord.push.apply(newWord, word.slice(i, j));
        i = j;
        if (word[i] === first && i < word.length - 1 && word[i + 1] === second) {
          newWord.push(first + second);
          i += 2;
        } else {
          newWord.push(word[i]);
          i += 1;
        }
      }
      word = newWord;
      if (word.length === 1) {
        break;
      }
      pairs = getPairs(word);
    }

    const result = word.join(" ");
    this.cache.set(token, result);
    return result;
  }

  encode(text, addSpecialTokens) {
    if (addSpecialTokens === undefined) {
      addSpecialTokens = true;
    }
    const ids = [];
    if (addSpecialTokens) {
      ids.push(this.bosId);
    }

    const cleaned = this.normalize(text);
    const pieces = cleaned.match(this.pat) || [];
    for (let p = 0; p < pieces.length; ++p) {
      const bytes = this.encoder.encode(pieces[p]);
      let mapped = "";
      for (let i = 0; i < bytes.length; ++i) {
        mapped += this.byteEncoder[bytes[i]];
      }
      const symbols = this.bpe(mapped).split(" ");
      for (let i = 0; i < symbols.length; ++i) {
        const id = this.vocab[symbols[i]];
        ids.push(id === undefined ? this.unkId : id);
      }
    }

    if (addSpecialTokens) {
      ids.push(this.eosId);
    }
    return { input_ids: Uint32Array.from(ids) };
  }
}
