'use client';

import { Component, type ReactNode } from 'react';

/**
 * Per-element crash isolation for the slide canvas.
 *
 * Every element renders model-generated DSL — untrusted input by nature. A
 * single malformed element (a table whose rows array carried spliced JSON
 * fragments took the whole app shell down in production, because the home
 * screen renders live slide previews) must degrade to "this element is
 * skipped", never to a React unmount of the surface hosting the slide.
 *
 * Logs once per boundary instance so a broken element in a long deck does
 * not flood the console on every re-render.
 */
interface Props {
  elementId?: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ElementErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  private logged = false;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (this.logged) return;
    this.logged = true;
    console.error(
      `[renderer] element ${this.props.elementId ?? '(unknown)'} failed to render and was skipped:`,
      error,
    );
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
