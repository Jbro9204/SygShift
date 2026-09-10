begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Match a selected human-readable @mention as literal text. The prior version
-- interpolated a label into a PostgreSQL regular expression and could fail on
-- every send with "quantifier operand invalid". Literal scanning avoids
-- treating any employee-name character as executable regular-expression syntax.
create or replace function private.sygsphere_body_has_mention(target_body text, target_label text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  normalized_body text := lower(coalesce(target_body, ''));
  normalized_label text := lower(trim(coalesce(target_label, '')));
  mention_token text;
  search_from integer := 1;
  relative_position integer;
  token_position integer;
  token_end integer;
  left_character text;
  right_character text;
  following_character text;
begin
  if normalized_label = '' then
    return false;
  end if;

  mention_token := '@' || normalized_label;

  loop
    relative_position := strpos(substring(normalized_body from search_from), mention_token);
    if relative_position = 0 then
      return false;
    end if;

    token_position := search_from + relative_position - 1;
    token_end := token_position + char_length(mention_token);
    left_character := case
      when token_position > 1 then substring(normalized_body from token_position - 1 for 1)
      else null
    end;
    right_character := case
      when token_end <= char_length(normalized_body) then substring(normalized_body from token_end for 1)
      else null
    end;
    following_character := case
      when token_end + 1 <= char_length(normalized_body) then substring(normalized_body from token_end + 1 for 1)
      else null
    end;

    if (left_character is null or left_character !~ '[[:alnum:]_]')
      and (
        right_character is null
        or right_character !~ '[[:alnum:]_.-]'
        or (
          right_character in ('.', '-')
          and (following_character is null or following_character !~ '[[:alnum:]_]')
        )
      ) then
      return true;
    end if;

    search_from := token_position + 1;
    if search_from > char_length(normalized_body) then
      return false;
    end if;
  end loop;
end
$$;

revoke all on function private.sygsphere_body_has_mention(text, text) from public, anon, authenticated;

do $$
begin
  assert private.sygsphere_body_has_mention('Hello @Michelle', 'Michelle'),
    'A simple first-name mention must match';
  assert private.sygsphere_body_has_mention('Hello @mIcHeLle!', 'Michelle'),
    'Mention matching must remain case-insensitive';
  assert private.sygsphere_body_has_mention('Hello @Michelle.', 'Michelle'),
    'Ordinary sentence punctuation must end a mention';
  assert private.sygsphere_body_has_mention('Please review with @Michelle Hood.', 'Michelle Hood'),
    'A full human name must match literally';
  assert private.sygsphere_body_has_mention('Please ask @Anne O''Neil (HR).', 'Anne O''Neil'),
    'Apostrophes in human names must match literally';
  assert private.sygsphere_body_has_mention('Please ask @A+B [Ops]!', 'A+B [Ops]'),
    'Regular-expression punctuation in a display label must remain literal';
  assert not private.sygsphere_body_has_mention('mail@Michelle', 'Michelle'),
    'A mention cannot begin inside another token';
  assert not private.sygsphere_body_has_mention('Hello @Michelle.Hood', 'Michelle'),
    'A short mention cannot end inside a longer account-style token';
  assert not private.sygsphere_body_has_mention('Hello everyone', ''),
    'An empty label must never match';
  assert not has_function_privilege('authenticated', 'private.sygsphere_body_has_mention(text,text)', 'EXECUTE'),
    'The private mention matcher must remain unavailable to authenticated clients';
  assert not has_function_privilege('anon', 'private.sygsphere_body_has_mention(text,text)', 'EXECUTE'),
    'The private mention matcher must remain unavailable to anonymous clients';
end
$$;

commit;
