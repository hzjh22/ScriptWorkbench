use encoding_rs::{CoderResult, Decoder, Encoding, GBK, UTF_8};

pub(crate) struct OutputDecoder {
    decoder: Decoder,
}

impl OutputDecoder {
    pub(crate) fn new(name: &str) -> Self {
        let encoding: &'static Encoding = if name == "gbk" { GBK } else { UTF_8 };
        Self {
            decoder: encoding.new_decoder(),
        }
    }

    pub(crate) fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut output = String::with_capacity(bytes.len().saturating_mul(2).max(32));
        let mut offset = 0;
        loop {
            let (result, read, _) =
                self.decoder
                    .decode_to_string(&bytes[offset..], &mut output, last);
            offset += read;
            if result == CoderResult::InputEmpty {
                break;
            }
            output.reserve(bytes.len().max(32));
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_gbk_output_without_mojibake() {
        let (bytes, _, _) = GBK.encode("任务完成");
        let mut decoder = OutputDecoder::new("gbk");
        assert_eq!(decoder.decode(&bytes, true), "任务完成");
    }

    #[test]
    fn preserves_utf8_sequences_split_across_chunks() {
        let bytes = "完成".as_bytes();
        let mut decoder = OutputDecoder::new("utf8");
        let first = decoder.decode(&bytes[..2], false);
        let second = decoder.decode(&bytes[2..], true);
        assert_eq!(format!("{first}{second}"), "完成");
    }
}
