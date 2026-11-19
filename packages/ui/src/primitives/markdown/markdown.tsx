import { createContext, useContext, useMemo, type ReactNode } from 'react';
import remarkGfm from 'remark-gfm';
import { Streamdown, type Components, type StreamdownProps } from 'streamdown';

import { css, cx } from '@ops/ui/css';

import {
  remarkCitationMarkers,
  remarkFirstLine,
  remarkHtmlAsText,
  remarkQuoteHighlight,
  safeMarkdownUrl,
  type PlaceMarkers,
} from './markdown-tree';

type Plugins = NonNullable<StreamdownProps['remarkPlugins']>;

/** Element renderers a document may take in place of its own; each gets the element's hast `node`. */
export type MarkdownComponents = Components;

// A single tilde stays literal, so "~5% to ~7%" is not struck through.
const GFM: Plugins[number] = [remarkGfm, { singleTilde: false }];

const inlineCode = {
  fontFamily: 'mono',
  fontSize: '0.92em',
  bg: 'palette.gray.3',
  rounded: 'sm',
  px: '1',
  py: '0.5',
} as const;

const documentRules = {
  lineHeight: '1.65',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  '& > :first-child': { mt: '0' },
  '& > :last-child': { mb: '0' },
  '& p, & ul, & ol, & blockquote, & pre, & [data-markdown-table], & hr': {
    my: '2.5',
  },
  // Plain-text values keep their line breaks, as they did before Markdown.
  '& p': { whiteSpace: 'pre-line' },
  '& h1, & h2, & h3, & h4, & h5, & h6': {
    fontWeight: '600',
    lineHeight: '1.3',
    mt: '4',
    mb: '2',
  },
  '& h1': { fontSize: '5' },
  '& h2': { fontSize: '4' },
  '& h3': { fontSize: '3' },
  '& h4, & h5, & h6': { fontSize: 'inherit' },
  '& ul': { listStyleType: 'disc', pl: '5' },
  '& ol': { listStyleType: 'decimal', pl: '5' },
  '& li + li': { mt: '1' },
  '& li > ul, & li > ol': { my: '1' },
  '& li:has(> input[type=checkbox])': { listStyleType: 'none', ml: '-5' },
  '& li > input[type=checkbox]': { mr: '1.5', verticalAlign: 'middle' },
  '& blockquote': {
    borderInlineStartWidth: '3px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'palette.gray.6',
    pl: '3',
    color: 'text.muted',
  },
  '& a': {
    color: 'palette.blue.11',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '& :not(pre) > code': inlineCode,
  '& pre': {
    fontFamily: 'mono',
    fontSize: '0.92em',
    lineHeight: '1.55',
    bg: 'palette.gray.2',
    border: '1px solid',
    borderColor: 'palette.gray.4',
    rounded: 'md',
    p: '3',
    overflowX: 'auto',
    whiteSpace: 'pre',
    overflowWrap: 'normal',
  },
  '& table': {
    borderCollapse: 'collapse',
    fontVariantNumeric: 'tabular-nums',
  },
  '& th, & td': {
    border: '1px solid',
    borderColor: 'palette.gray.4',
    px: '2.5',
    py: '1.5',
    textAlign: 'left',
    verticalAlign: 'top',
    overflowWrap: 'normal',
  },
  '& th': { bg: 'palette.gray.2', fontWeight: '600' },
  '& th[align=right], & td[align=right]': { textAlign: 'right' },
  '& th[align=center], & td[align=center]': { textAlign: 'center' },
  '& hr': { borderTop: '1px solid', borderColor: 'palette.gray.4' },
  '& mark': { bg: 'palette.amber.4', color: 'text.app', rounded: 'sm' },
} as const;

const documentStyle = css(documentRules);

/** A Chat answer reads as prose: larger type, looser lines, paragraphs spaced below only. */
const answerStyle = css({
  ...documentRules,
  fontSize: '2',
  lineHeight: 'prose',
  '& p': { whiteSpace: 'pre-line', mt: '0', mb: '2.5' },
  '& strong': { fontWeight: '600' },
});

const VARIANT_STYLES = { document: documentStyle, answer: answerStyle };

/** The renderer's root box flows inline, so a preview stays one line of text. */
const lineStyle = css({ display: 'inline', '& code': inlineCode });

/** Links always leave the app in a new tab; a link whose URL was dropped stays text. */
const Link: Components['a'] = ({ href, children }) =>
  href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );

/** Values never load remote images; the alt text stands in. */
const ImageAlt: Components['img'] = ({ alt }) =>
  alt ? <span>{alt}</span> : null;

const tableScrollStyle = css({
  maxW: 'full',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  pb: '1.5',
  '&::-webkit-scrollbar': { h: '1.5' },
  '&::-webkit-scrollbar-thumb': { bg: 'palette.gray.7', rounded: 'full' },
  '&::-webkit-scrollbar-track': { bg: 'palette.gray.3', rounded: 'full' },
});

/** A table wider than its column scrolls sideways in its own box, so the page around it never does;
 * the box takes focus so the keyboard can scroll it too. */
const ScrollingTable: Components['table'] = ({ children }) => (
  <div
    className={tableScrollStyle}
    data-markdown-table=""
    role="region"
    aria-label="Table"
    tabIndex={0}
  >
    <table>{children}</table>
  </div>
);

const RenderMarker = createContext<((index: number) => ReactNode) | null>(null);

const keepTogetherStyle = css({ whiteSpace: 'nowrap' });

/** A citation chip where the markers plugin left one, or the unbreakable group of a word and its chips;
 * a stable type, so chips keep focus across renders. */
const MarkerSpan: Components['span'] = ({ node, children }) => {
  const render = useContext(RenderMarker);
  const index = node?.properties.dataCitation;
  if (typeof index === 'number' && render) return render(index);
  if (node?.properties.dataCitationGroup)
    return (
      <span className={keepTogetherStyle} data-citation-group="">
        {children}
      </span>
    );
  return <span>{children}</span>;
};

/** Plain elements in place of the renderer's own (code headers, table controls, utility classes), so the document
 * styles above shape every block. */
const PLAIN_ELEMENTS: Components = {
  blockquote: 'blockquote',
  code: 'code',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
  li: 'li',
  ol: 'ol',
  p: 'p',
  pre: 'pre',
  section: 'section',
  strong: 'strong',
  sub: 'sub',
  sup: 'sup',
  tbody: 'tbody',
  td: 'td',
  th: 'th',
  thead: 'thead',
  tr: 'tr',
  ul: 'ul',
};

const DOCUMENT_COMPONENTS: Components = {
  ...PLAIN_ELEMENTS,
  a: Link,
  img: ImageAlt,
  span: MarkerSpan,
  table: ScrollingTable,
};

/** The renderer caches its pipeline by each plugin's serialised options, which drop functions, so each chip placer
 * gets a number that tells its pipeline apart. */
const placers = { versions: new WeakMap<PlaceMarkers, number>(), last: 0 };

const placerVersion = (place: PlaceMarkers) => {
  const known = placers.versions.get(place);
  if (known !== undefined) return known;
  placers.last += 1;
  placers.versions.set(place, placers.last);
  return placers.last;
};

/** No raw-HTML, sanitize or link-hardening passes: raw HTML is already text and `safeMarkdownUrl` keeps links safe. */
const NO_REHYPE: NonNullable<StreamdownProps['rehypePlugins']> = [];

/**
 * A Markdown document. Raw HTML shows as literal text and only http, https and mailto links survive; `markers` places
 * inline citation chips and `highlight` marks a quote. `streaming` renders text still being written: unclosed syntax
 * is closed and finished blocks are not parsed again; chips and highlights wait for the finished text.
 */
export function MarkdownDocument({
  text,
  markers,
  highlight,
  className,
  components,
  variant = 'document',
  streaming = false,
}: {
  text: string;
  markers?: {
    place: PlaceMarkers;
    render: (index: number) => ReactNode;
  };
  highlight?: string;
  className?: string;
  /** Elements a feature renders its own way, such as a Chat answer's tables; keep the object stable. */
  components?: MarkdownComponents;
  variant?: keyof typeof VARIANT_STYLES;
  streaming?: boolean;
}) {
  const elements = useMemo(
    () =>
      components
        ? { ...DOCUMENT_COMPONENTS, ...components }
        : DOCUMENT_COMPONENTS,
    [components],
  );
  const plugins: Plugins = [GFM, remarkHtmlAsText];
  const version = markers && !streaming ? placerVersion(markers.place) : 0;
  if (markers && !streaming)
    plugins.push([remarkCitationMarkers, { place: markers.place, version }]);
  if (highlight && !streaming)
    plugins.push([remarkQuoteHighlight, { quote: highlight }]);
  return (
    <RenderMarker.Provider value={markers?.render ?? null}>
      <Streamdown
        className={cx(VARIANT_STYLES[variant], className)}
        data-markdown="document"
        // The renderer re-renders on its text and data attributes only, so new chips or a new quote change this one.
        data-markdown-plugins={`${version}:${highlight ?? ''}`}
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        remarkPlugins={plugins}
        rehypePlugins={NO_REHYPE}
        components={elements}
        controls={false}
        urlTransform={safeMarkdownUrl}
        skipHtml
      >
        {text}
      </Streamdown>
    </RenderMarker.Provider>
  );
}

const LINE_PLUGINS: Plugins = [GFM, remarkHtmlAsText, remarkFirstLine];
const LINE_COMPONENTS: Components = {
  ...PLAIN_ELEMENTS,
  p: ({ children }) => children,
  a: ({ children }) => <span>{children}</span>,
  img: ImageAlt,
};

/** The first meaningful line of a Markdown value, inline and without block syntax, for one-line previews. */
export function MarkdownLine({ text }: { text: string }) {
  return (
    <Streamdown
      className={lineStyle}
      data-markdown="line"
      mode="static"
      remarkPlugins={LINE_PLUGINS}
      rehypePlugins={NO_REHYPE}
      components={LINE_COMPONENTS}
      controls={false}
      urlTransform={safeMarkdownUrl}
      skipHtml
    >
      {text}
    </Streamdown>
  );
}
