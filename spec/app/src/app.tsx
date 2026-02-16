import { useState } from "react";
import "./app.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="app">
      <nav>
        <a href="/">Home</a> <a href="/app">App</a>
      </nav>
      <h1>App</h1>
      <div className="card">
        <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
    </div>
  );
}

export default App;
