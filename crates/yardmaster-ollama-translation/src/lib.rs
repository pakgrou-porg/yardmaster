// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Ollama-native translation for Yardmaster.
//!
//! Switchyard's translation layer covers OpenAI Chat, OpenAI Responses, and
//! Anthropic Messages. This crate adds the Ollama-native surface —
//! `/api/chat`, `/api/generate`, `/api/tags`, `/api/show`, including the
//! streaming NDJSON response shape — as request/response codecs over
//! `switchyard-protocol` types. It does **not** modify vendored Switchyard
//! translation code (spec 1.2).
//!
//! Round-trip tests (chat, generate, tags, show, streaming) are required by
//! spec section 6. Implementation is tracked by a `blocked` issue.

#![forbid(unsafe_code)]

use switchyard_protocol as _; // linked; codec types land here.

/// The Ollama endpoint a request or response belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OllamaSurface {
    ApiChat,
    ApiGenerate,
    ApiTags,
    ApiShow,
}

/// Translation errors, mapped onto Switchyard's error space by the caller.
#[derive(Debug, thiserror::Error)]
pub enum OllamaTranslationError {
    #[error("unsupported Ollama field: {0}")]
    Unsupported(String),
    #[error("malformed Ollama payload: {0}")]
    Malformed(String),
}
