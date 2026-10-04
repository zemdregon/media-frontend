import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { Me, ThemePreference } from '@cinewren/shared';
import { api } from '../api-client';
import {
  CollectionsIcon,
  HomeIcon,
  Logo,
  MoviesIcon,
  SearchIcon,
  ServersIcon,
  SettingsIcon,
  ShowsIcon,
} from '../components/icons';
import { SkeletonBlock, initials } from '../components/ui';
import { Link, matchPath, useRouter } from '../lib/router';
import { Home } from './Home';

// Everything except the home route is split into its own chunk (NFR-PERF-003).
const Browse = lazy(() => import('./Browse').then((m) => ({ default: m.Browse })));
const SearchResults = lazy(() =>
  import('./SearchResults').then((m) => ({ default: m.SearchResults })),
);
const ItemDetail = lazy(() => import('./ItemDetail').then((m) => ({ default: m.ItemDetail })));
const Player = lazy(() => import('./Player').then((m) => ({ default: m.Player })));
const PersonPage = lazy(() => import('./People').then((m) => ({ default: m.PersonPage })));
const CollectionsPage = lazy(() =>
  import('./People').then((m) => ({ default: m.CollectionsPage })),
);
const CollectionPage = lazy(() => import('./People').then((m) => ({ default: m.CollectionPage })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));
const Servers = lazy(() => import('./Servers').then((m) => ({ default: m.Servers })));
const AuditLog = lazy(() => import('./AuditLog').then((m) => ({ default: m.AuditLog })));
const SyncStatus = lazy(() => import('./SyncStatus').then((m) => ({ default: m.SyncStatus })));

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  operatorOnly?: boolean;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: <HomeIcon />, match: (p) => p === '/' },
  { to: '/movies', label: 'Movies', icon: <MoviesIcon />, match: (p) => p === '/movies' },
  { to: '/shows', label: 'Shows', icon: <ShowsIcon />, match: (p) => p === '/shows' },
  {
    to: '/collections',
    label: 'Collections',
    icon: <CollectionsIcon />,
    match: (p) => p.startsWith('/collections'),
  },
  {
    to: '/servers',
    label: 'Servers',
    icon: <ServersIcon />,
    operatorOnly: true,
    match: (p) => p.startsWith('/servers'),
  },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon />, match: (p) => p === '/settings' },
];

/** Signed-in shell: sidebar nav, search, account button and the route outlet (UX §4). */
export function Shell({
  me,
  onSignedOut,
  onThemeSaved,
}: {
  me: Me;
  onSignedOut: () => void;
  onThemeSaved: (t: ThemePreference) => void;
}) {
  const { location } = useRouter();
  const [busy, setBusy] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page on in-app navigation so keyboard and screen-reader users start at the top.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [location.path]);

  const signOut = async () => {
    setBusy(true);
    try {
      await api('POST', '/auth/logout');
    } finally {
      setBusy(false);
      onSignedOut();
    }
  };

  const operator = me.role === 'operator';
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav aria-label="Main" className="side-nav">
        <div className="brand">
          <Logo />
          <span className="wordmark-text">Cinewren</span>
        </div>
        <ul>
          {NAV.filter((n) => !n.operatorOnly || operator).map((n) => (
            <li key={n.to}>
              <Link
                to={n.to}
                className="nav-item"
                {...(n.match(location.path) ? { 'aria-current': 'page' as const } : {})}
              >
                {n.icon}
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="main-col">
        <Header me={me} />
        <main id="main" ref={mainRef} tabIndex={-1} className="main">
          <Suspense fallback={<SkeletonBlock label="Loading page" />}>
            <Routes
              me={me}
              operator={operator}
              onThemeSaved={onThemeSaved}
              onSignOut={() => void signOut()}
              signingOut={busy}
            />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function Header({ me }: { me: Me }) {
  const { location, navigate } = useRouter();
  const onSearchRoute = location.path === '/search';
  const urlQuery = onSearchRoute ? (location.search.get('q') ?? '') : '';
  const [text, setText] = useState(urlQuery);
  const [prev, setPrev] = useState(urlQuery);
  // Keep the field in step with the URL (back/forward, or leaving the search route).
  if (prev !== urlQuery) {
    setPrev(urlQuery);
    setText(urlQuery);
  }

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <header className="topbar">
      <form role="search" className="search" onSubmit={submit}>
        <SearchIcon />
        <label htmlFor="q" className="sr-only">
          Search every server
        </label>
        <input
          id="q"
          type="search"
          value={text}
          maxLength={100}
          placeholder="Search titles, people, collections across all servers"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setText('');
          }}
        />
      </form>
      <Link to="/settings" className="account-button" aria-label={`Account, ${me.displayName}`}>
        {initials(me.displayName)}
      </Link>
    </header>
  );
}

function NotFoundPage() {
  return (
    <section className="callout">
      <h1 className="h-display">Page not found</h1>
      <p className="helper">That address does not lead anywhere in Cinewren.</p>
      <Link to="/" className="button button-outline">
        Back to Home
      </Link>
    </section>
  );
}

function Routes({
  me,
  operator,
  onThemeSaved,
  onSignOut,
  signingOut,
}: {
  me: Me;
  operator: boolean;
  onThemeSaved: (t: ThemePreference) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const { location } = useRouter();
  const path = location.path.length > 1 ? location.path.replace(/\/$/, '') : location.path;

  if (path === '/') return <Home />;
  if (path === '/movies') return <Browse type="movie" />;
  if (path === '/shows') return <Browse type="series" />;
  if (path === '/search') return <SearchResults />;
  if (path === '/collections') return <CollectionsPage />;
  if (path === '/settings') {
    return (
      <Settings me={me} onThemeSaved={onThemeSaved} onSignOut={onSignOut} signingOut={signingOut} />
    );
  }
  if (operator && path === '/servers') return <Servers />;
  if (operator && path === '/servers/sync') return <SyncStatus />;
  if (operator && path === '/servers/audit') return <AuditLog />;
  const item = matchPath('/items/:id', path);
  if (item?.id) return <ItemDetail key={item.id} id={item.id} />;
  const watch = matchPath('/watch/:id', path);
  if (watch?.id) return <Player key={watch.id} id={watch.id} />;
  const person = matchPath('/people/:id', path);
  if (person?.id) return <PersonPage key={person.id} id={person.id} />;
  const collection = matchPath('/collections/:id', path);
  if (collection?.id) return <CollectionPage key={collection.id} id={collection.id} />;
  return <NotFoundPage />;
}
