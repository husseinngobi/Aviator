function Panel({ title, subtitle, children }) {
  return (
    <section className="panel-card">
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default Panel;