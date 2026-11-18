/**
 * A small XML reader for Office files (DOCX, PPTX are zipped XML).
 *
 * Deliberately minimal: elements, attributes, text, CDATA, the five standard entities and numeric
 * character references. Names are matched by their local part (`w:p` and `p` are both "p"), because
 * the prefixes are a convention that generators do not always follow.
 *
 * DTDs are not supported and a document that declares entities is rejected, so there is no entity
 * expansion to abuse ("billion laughs").
 */

export interface XmlElement {
  /** Name without its namespace prefix. */
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | string>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[body] ?? whole;
  });
}

const local = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1);

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(source)) !== null) attrs[local(m[1])] = decode(m[2] ?? m[3] ?? '');
  return attrs;
}

export function parseXml(xml: string): XmlElement {
  if (/<!ENTITY/i.test(xml)) throw new Error('XML with entity declarations is not supported');
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) stack[stack.length - 1].children.push(decode(xml.slice(i, textEnd)));
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const stop = end === -1 ? n : end;
      stack[stack.length - 1].children.push(xml.slice(lt + 9, stop));
      i = end === -1 ? n : end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
    } else if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? n : end + 1;
    } else {
      // An opening tag. Find its end, skipping '>' inside quoted attribute values.
      let j = lt + 1;
      let quote = '';
      while (j < n) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      let inner = xml.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const space = inner.search(/\s/);
      const qualified = space === -1 ? inner : inner.slice(0, space);
      const el: XmlElement = {
        name: local(qualified),
        attrs: space === -1 ? {} : parseAttrs(inner.slice(space)),
        children: [],
      };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }

  const top = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!top) throw new Error('No XML element found');
  return top;
}

/** Child elements (skipping text), optionally only those named `name`. */
export function kids(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (name === undefined || c.name === name));
}

export function firstKid(el: XmlElement, name: string): XmlElement | undefined {
  return kids(el, name)[0];
}

/** The text directly inside an element. */
export function ownText(el: XmlElement): string {
  return el.children.filter((c): c is string => typeof c === 'string').join('');
}

/** Every descendant element named `name`, in document order. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
