/** One row of the sign-in welcome panel: an at-risk item, what the agents are doing about it, and where it stands. */
export type WelcomeTask = {
  code: string;
  title: string;
  detail: string;
  tone: 'done' | 'working' | 'needs';
  status: string;
  typing?: boolean;
};
