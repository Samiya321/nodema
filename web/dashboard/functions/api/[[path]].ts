export const onRequest: PagesFunction<Env> = ({request,env}) => env.API.fetch(request);
