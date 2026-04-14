import React from "react";

function EventFeed({ items }) {
  return (
    <div className="event-feed">
      {items.map((item) => (
        <div key={item.id} className="event-row">
          <span className={`event-dot ${item.kind}`} />
          <div className="event-copy">
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </div>
          <time>{item.time}</time>
        </div>
      ))}
    </div>
  );
}

export default EventFeed;