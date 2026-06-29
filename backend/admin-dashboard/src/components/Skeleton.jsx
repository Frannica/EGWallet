export default function SkeletonGrid({ count = 6, columns = 3 }) {
  return (
    <div className="skeleton-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-block" />
      ))}
    </div>
  );
}

export function SkeletonLines({ count = 4 }) {
  return (
    <div className="skeleton-lines">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${90 - i * 10}%` }} />
      ))}
    </div>
  );
}
