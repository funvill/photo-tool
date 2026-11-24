import { useId, useState } from 'react';
import { normalisePeople } from '../../../core';
import { Icon } from '../../../web/components/Icon';

/**
 * People in a photo as chips. Enter or a comma adds what is typed (so does leaving the box), a chip's
 * button removes it, and every change is handed to `onChange` as the whole new list. Names are
 * suggested from the people already named in the folder.
 */
export function PeopleInput({ value, suggestions, onChange }: { value: string[]; suggestions: string[]; onChange(next: string[]): void }) {
  const [text, setText] = useState('');
  const listId = useId();

  const add = (raw: string) => {
    const typed = raw.split(',');
    setText('');
    const next = normalisePeople([...value, ...typed]);
    if (next.length !== value.length) onChange(next);
  };
  const remove = (name: string) => onChange(value.filter((n) => n !== name));

  return (
    <div className="gallery-people">
      {value.length > 0 && (
        <ul className="gallery-chips">
          {value.map((name) => (
            <li key={name} className="gallery-chip">
              <span>{name}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${name}`} onClick={() => remove(name)}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        list={listId}
        value={text}
        placeholder="Add a name, press Enter"
        aria-label="Add a person"
        onChange={(e) => {
          // A comma ends a name, also when it arrives inside pasted text.
          if (e.target.value.includes(',')) add(e.target.value);
          else setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      <datalist id={listId}>
        {suggestions.filter((n) => !value.some((v) => v.toLowerCase() === n.toLowerCase())).map((n) => <option key={n} value={n} />)}
      </datalist>
    </div>
  );
}
