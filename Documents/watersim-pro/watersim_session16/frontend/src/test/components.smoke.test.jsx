import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmptyState from '../components/EmptyState';
import ErrorBoundary from '../components/ErrorBoundary';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmptyState', () => {
  it('renders title, description, and a working action', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No reports yet"
        description="Completed simulation runs will appear here."
        action={{ label: 'Browse all reports', onClick }}
      />
    );

    expect(screen.getByText('No reports yet')).toBeInTheDocument();
    expect(screen.getByText('Completed simulation runs will appear here.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Browse all reports' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

function Boom() {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  it('renders the fallback UI when a child throws', () => {
    // React logs the caught error — keep the test output clean
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary scope="TestSection">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/TestSection encountered an unexpected error/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary scope="TestSection">
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
