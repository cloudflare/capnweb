/**
 * MDX globals registry — components available inside MDX without `import`.
 * Wired via `<Content components={components} />` in `[...slug].astro`, and
 * parsed at build time by the MDX validator, which fails the build on a
 * PascalCase tag that is neither registered here nor imported by the page.
 */

import { Aside } from './components/ui/aside';
import { Card } from './components/ui/card';
import { CardGrid } from './components/ui/card-grid';
import { LinkCard } from './components/ui/link-card';
import { PackageManagers } from './components/ui/package-managers';
import Render from './components/Render.astro';
import { Step, Steps } from './components/ui/steps';
import { Tabs, TabItem } from './components/ui/tabs';

// Ours, not Nimbus's.
import Hero from './components/Hero.astro';
import Playground from './components/Playground.astro';
import Prose from './components/Prose.astro';

export const components = {
	Aside,
	Card,
	CardGrid,
	Hero,
	LinkCard,
	PackageManagers,
	Playground,
	Prose,
	Render,
	Step,
	Steps,
	TabItem,
	Tabs,
};
