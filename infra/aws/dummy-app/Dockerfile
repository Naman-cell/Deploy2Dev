FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html

# nginx:alpine already EXPOSEs 80 and runs as PID 1 in the foreground;
# this matches the sandbox ECS task's ContainerPort 80 with no task-def edits.
