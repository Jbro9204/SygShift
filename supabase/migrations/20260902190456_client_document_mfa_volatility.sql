begin;

alter function private.require_recent_client_document_mfa(text,timestamptz) volatile;

commit;
